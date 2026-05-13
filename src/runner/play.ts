/**
 * Generic play harness for Brigliadoro runners.
 *
 * This file is copied into each generated runner at build time.
 * It reads config.json, loads the game's MCP server, builds the
 * facilitator system prompt, and runs an interactive terminal play loop.
 *
 * Usage: npx tsx play.ts
 */
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buildFacilitatorSystemPrompt } from "./lib/runner/facilitator-prompt-template.js";
import { createFacilitatorMemoryTools } from "./lib/runner/facilitator-memory.js";
import { createTranscriptWriter } from "./lib/runner/transcript.js";
import { runBookkeeper } from "./lib/runner/bookkeeper.js";
import type { BookSnapshot } from "./lib/runner/bookkeeper.js";
import { createSubagentTrace } from "./lib/runner/subagent-trace.js";
import { createDirectorTrace } from "./lib/runner/director-trace.js";
import {
  createScriptSource,
  createScriptTailSource,
  createStdinSource,
} from "./lib/runner/player-input.js";
import type { PlayerInputSource } from "./lib/runner/player-input.js";
import {
  applySeedMode,
  loadPlayerPreferences,
  parseRunnerArgs,
} from "./lib/runner/cli-args.js";
import {
  clearAllState,
  clearSessionId,
  confirmPrompt,
  resolveSessionMode,
} from "./lib/runner/session-mode.js";
import {
  buildInitialPrompt,
  presentOpeningMessage,
} from "./lib/runner/opening-message.js";
// Per-turn agent invocation lives behind the TurnRunner strategy
// interface; play.ts holds the input loop + bookkeeper plumbing.
// Phase-4 cutover deletes the monolith implementation.
import type { TurnRunner } from "./lib/runner/turn-runner.js";
import { createMonolithTurnRunner } from "./lib/runner/monolith-turn-runner.js";
import { createSplitTurnRunner } from "./lib/runner/split-turn-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// ── Bookkeeper helpers ─────────────────────────────────────────────────

/** Read the three book JSON files and return a compact name → summary
 *  snapshot for the bookkeeper. Missing or corrupt files yield empty
 *  per-book maps (the bookkeeper just sees "(empty)" for that book).
 *  This runs every turn — it's a synchronous file read of three small
 *  JSONs, well under a millisecond at session-realistic sizes. */
function readBookSnapshot(stateDir: string): BookSnapshot {
  return {
    npcs: readBookSummaries(path.join(stateDir, "npcs.json")),
    factions: readBookSummaries(path.join(stateDir, "factions.json")),
    character_sheets: readBookSummaries(path.join(stateDir, "character-sheets.json")),
  };
}

function readBookSummaries(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("records" in parsed) ||
    typeof (parsed as { records: unknown }).records !== "object" ||
    (parsed as { records: unknown }).records === null
  ) {
    return {};
  }
  const records = (parsed as { records: Record<string, unknown> }).records;
  const out: Record<string, string> = {};
  for (const [name, record] of Object.entries(records)) {
    if (record && typeof record === "object" && "summary" in record) {
      const s = (record as { summary?: unknown }).summary;
      out[name] = typeof s === "string" ? s : "";
    } else {
      out[name] = "";
    }
  }
  return out;
}

/**
 * Produce a ≤500-char premise/tone snippet for the bookkeeper's context.
 * Prefers `config.description` (already crisp, set by the characterizer);
 * falls back to a truncated head of the lore summary JSON.
 */
function buildShortLoreSummary(
  config: { description?: string; name?: string },
  loreSummary: string | undefined
): string {
  const desc = typeof config.description === "string" ? config.description.trim() : "";
  if (desc) return desc.length > 500 ? desc.slice(0, 500) + "…" : desc;
  if (!loreSummary) return "";
  const stripped = loreSummary.replace(/\s+/g, " ").trim();
  return stripped.length > 500 ? stripped.slice(0, 500) + "…" : stripped;
}

async function main() {
  // Load runner config
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      "No config.json found. Are you running this from a runner directory?"
    );
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // Parse CLI args (pure). Errors print and exit; success returns a typed
  // RunnerArgs.
  const argResult = parseRunnerArgs(process.argv.slice(2));
  if (!argResult.ok) {
    console.error(argResult.error);
    process.exit(1);
  }
  const args = argResult.args;

  // Apply seed mode early — this monkey-patches Math.random process-wide
  // so tool primitives become deterministic. Must happen BEFORE the game
  // server is dynamically imported, since tool factories may use RNG at
  // construction.
  applySeedMode(args.seedMode);

  // Load --player-preferences file (file IO; exits on error). Done early so
  // we fail fast before booting the game server / agents.
  let playerPreferencesText: string | undefined;
  if (args.playerPreferencesPath) {
    try {
      playerPreferencesText = loadPlayerPreferences(args.playerPreferencesPath);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Dynamically import the game server. With seed mode installed above,
  // any RNG this server touches during construction is already patched.
  const serverModule = await import("./tools/server.js");
  const gameServer = serverModule.createGameServer();

  // Create facilitator memory server (scratchpad + typed books for NPCs, factions, character sheets)
  const stateDir = path.join(__dirname, "state");
  const facilitatorServer = createSdkMcpServer({
    name: "facilitator",
    version: "1.0.0",
    tools: createFacilitatorMemoryTools(stateDir),
  });

  // Load lore summary
  const lorePath = path.join(__dirname, "lore", "summary.json");
  let loreSummary: string | undefined;
  if (fs.existsSync(lorePath)) {
    const lore = JSON.parse(fs.readFileSync(lorePath, "utf-8"));
    loreSummary = JSON.stringify(lore, null, 2);
  }

  // Build the full facilitator system prompt
  const { facilitatorPrompt, characterCreation, shipCreation } = config;
  const additionalCreation: Record<string, unknown> = {};
  if (shipCreation) additionalCreation.shipCreation = shipCreation;

  const systemPrompt = buildFacilitatorSystemPrompt({
    gamePrompt: facilitatorPrompt,
    gameName: config.name,
    loreSummary,
    characterCreation,
    additionalCreation:
      Object.keys(additionalCreation).length > 0
        ? additionalCreation
        : undefined,
  });

  // Seed-mode label threaded into transcript headers; also referenced by
  // /new and /new-session handlers when they begin a fresh session.
  const seedModeLabel = args.seedMode?.label;

  // Display header
  console.log(`\n${config.name}`);
  console.log(`${config.description}`);
  console.log(`Source: ${config.source} (${config.license})`);
  console.log(
    `\nType /quit to exit, /new to wipe all state, /new-session for a fresh session (keeps world).\n`
  );

  // Player input source — stdin by default; --player-script=FILE swaps in
  // a pre-recorded NDJSON script; --player-script-tail=FILE tails the file
  // for appended lines so an external driver can feed turns live.
  const usingScriptedInput = Boolean(
    args.playerScriptPath || args.playerScriptTailPath
  );
  const rl = usingScriptedInput ? null : createReadline();
  const playerSource: PlayerInputSource = args.playerScriptPath
    ? createScriptSource(args.playerScriptPath)
    : args.playerScriptTailPath
    ? createScriptTailSource(args.playerScriptTailPath)
    : createStdinSource(rl!);
  if (args.playerScriptPath) {
    console.log(
      `[player source: script — reading input from ${args.playerScriptPath}]\n`
    );
  } else if (args.playerScriptTailPath) {
    console.log(
      `[player source: script-tail — tailing ${args.playerScriptTailPath} for appended turns]\n`
    );
  }

  if (args.playerPreferencesPath) {
    console.log(
      `[player preferences: loaded from ${args.playerPreferencesPath} — facilitator will skip session-zero questions]\n`
    );
  }

  const sharedOptions = {
    systemPrompt,
    mcpServers: {
      [gameServer.name]: gameServer,
      facilitator: facilitatorServer,
    },
    model: "sonnet",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    tools: [] as string[],
  };

  // Transcript logger — per-session markdown file under state/transcripts/.
  // Tail-mode players (e.g. brigliadoro-roland) are external drivers and
  // need the `<<<BRIGLIADORO-AWAITING ...>>>` stdout markers to detect
  // turn boundaries; stdin and one-shot script modes are for humans and
  // test fixtures, where the marker line would just be visual noise.
  const transcript = createTranscriptWriter(stateDir, {
    emitAwaitingMarkers: args.playerScriptTailPath !== undefined,
  });

  // Subagent trace — per-session JSONL next to the markdown transcript.
  const subagentTrace = createSubagentTrace(stateDir);

  // Short premise/tone summary we thread into the bookkeeper's context.
  // The bookkeeper runs on Haiku with a fresh context; it doesn't need full
  // lore, just enough to recognise setting-appropriate entity types.
  const loreSummaryShort = buildShortLoreSummary(config, loreSummary);

  // Facilitator-role key used in the bookkeeper's context. Plan: future
  // config.json schemas may surface this explicitly per-game; for now we
  // fall back to a neutral default.
  const facilitatorRole: string =
    (config.facilitatorRole as string | undefined) ?? "facilitator";

  // Turn counter for bookkeeper trace correlation. Incremented before
  // each streamTurn call.
  let turnNumber = 0;

  // Fire-and-track pending bookkeeper invocation. Awaited before the next
  // facilitator turn (so the books reflect turn N before turn N+1 reads
  // them) and on /quit / /new / /new-session (so writes land before
  // we wipe state or exit).
  let pendingBookkeeper: Promise<void> | null = null;

  function enqueueBookkeeper(input: {
    turnText: string;
    turn: number;
    sessionId: string;
  }): void {
    if (!input.turnText.trim() || !input.sessionId) return;
    // Snapshot is taken at enqueue time (right after the facilitator's turn
    // settles) so the bookkeeper sees the state as of just-before-its-own-
    // writes. Long-session caveat: this payload grows with the books.
    const bookSnapshot = readBookSnapshot(stateDir);
    pendingBookkeeper = runBookkeeper(
      {
        turnText: input.turnText,
        turn: input.turn,
        sessionId: input.sessionId,
        gameContext: {
          gameName: config.name,
          facilitatorRole,
          loreSummaryShort,
        },
        bookSnapshot,
      },
      facilitatorServer,
      subagentTrace
    )
      .then((result) => {
        transcript.recordSubagentSummary(
          "bookkeeper",
          result.toolCalls,
          result.summary
        );
      })
      .catch((err) => {
        console.error(`\n[bookkeeper] ${(err as Error).message ?? err}`);
      });
  }

  async function awaitPendingBookkeeper(): Promise<void> {
    if (pendingBookkeeper) {
      await pendingBookkeeper;
      pendingBookkeeper = null;
    }
  }

  // The optional pre-rendered opening message — generated by the
  // characterizer at runner-build-time, displayed to the player before the
  // first agent call so the player sees the game's voice immediately.
  // The agent's first turn then picks up from "the player saw the opening
  // and responded with X." Falls back to the agent generating its own
  // greeting when this field is absent (older runners).
  const openingMessage =
    typeof (config as { openingMessage?: unknown }).openingMessage === "string"
      ? ((config as { openingMessage: string }).openingMessage)
      : undefined;

  const resumePrompt = `The player has returned to the game after closing the terminal. Follow your sitting-management protocol: read your scratchpad and \`list\` your npcs/factions/character_sheets books to reorient, then recap briefly (a sentence or two on where we left off) and ask what they want to do next. Don't dump the full memory state — just orient.`;
  const freshSessionPrompt = `The player has started a fresh session. Read your scratchpad and \`list\` your npcs/factions/character_sheets books to see what world state already exists. If there are existing PC(s), NPCs, or factions, greet the player warmly, briefly describe what you remember, and ask whether they're continuing with an existing PC, introducing a new PC in this world, or starting something else. If the books are empty, this is a true first session — run the session zero greeting flow.`;

  // ── Resolve session mode + build the per-turn agent runner ────────────
  // The TurnRunner strategy interface absorbs per-turn agent invocation
  // so this file holds only the input loop + bookkeeper plumbing. Two
  // implementations: monolith (one query() per turn, full system prompt,
  // resume threaded across turns and persisted to disk) and split-agents
  // Phase 1 (Director + Narrator with ephemeral session ids only — no
  // cross-run persistence, /new and /new-session blocked at the input
  // layer). Phase-4 cutover deletes the monolith.
  let firstMode: "initial" | "fresh-session" | "resume";
  let resumeId: string | undefined;
  if (args.splitAgents) {
    console.log(
      "[--split-agents: Phase-1 runtime — Director + Narrator split. /resume, /new, /new-session not supported in this mode yet.]\n"
    );
    firstMode = "initial";
    resumeId = undefined;
  } else {
    const resolved = await resolveSessionMode({
      stateDir,
      forced: args.sessionMode,
      playerSource,
    });
    firstMode = resolved.firstMode;
    resumeId = resolved.resumeId;
    if (resumeId) {
      console.log(`[Resuming session ${resumeId.slice(0, 8)}…]\n`);
    }
  }

  // Per-session JSONL diagnostic trace for the Director + Narrator. Only
  // created in split-agents mode (the monolith has no Director). Writes
  // to `state/transcripts/<shortid>.director.jsonl` next to the
  // markdown + bookkeeper-trace files. The whole point: when the Director
  // returns prose instead of JSON (Q17), the leaked text is recoverable
  // for debugging rather than being lost to the terminal.
  const directorTrace = args.splitAgents
    ? createDirectorTrace(stateDir)
    : undefined;

  const turnRunner: TurnRunner = args.splitAgents
    ? createSplitTurnRunner({
        gameSystemPrompt: systemPrompt,
        gameServer,
        facilitatorServer,
        transcript,
        directorTrace,
      })
    : createMonolithTurnRunner({
        sharedOptions,
        stateDir,
        initialSessionId: resumeId,
        transcript,
      });

  transcript.beginSession({
    gameName: config.name,
    mode: firstMode,
    seedLabel: seedModeLabel,
  });

  // In initial mode, show the pre-rendered opening (if configured) and
  // capture the player's first response before the agent's first call.
  // Saves an LLM call and ensures a consistent first impression in the
  // characterizer-set voice. Resume / fresh-session modes skip the
  // opening — the player has been here before.
  let firstPlayerResponseAfterOpening: string | undefined;
  if (firstMode === "initial") {
    const opening = await presentOpeningMessage({
      openingMessage,
      playerSource,
      transcript,
    });
    if (opening.kind === "quit") {
      await playerSource.close();
      console.log("\n[Thanks for playing!]");
      return;
    }
    if (opening.kind === "responded") {
      firstPlayerResponseAfterOpening = opening.text;
    }
  }

  const firstPrompt =
    firstMode === "resume"
      ? resumePrompt
      : firstMode === "fresh-session"
        ? freshSessionPrompt
        : buildInitialPrompt({
            gameName: config.name,
            openingMessage,
            playerFirstResponse: firstPlayerResponseAfterOpening,
            playerPreferencesText,
          });

  turnNumber += 1;
  const firstResult = await turnRunner.runTurn({
    userPrompt: firstPrompt,
    playerInput: firstPlayerResponseAfterOpening,
    turn: turnNumber,
  });
  enqueueBookkeeper({
    turnText:
      firstPlayerResponseAfterOpening !== undefined
        ? `> ${firstPlayerResponseAfterOpening}\n\n${firstResult.facilitatorText}`
        : firstResult.facilitatorText,
    turn: turnNumber,
    sessionId: firstResult.sessionIdForTrace,
  });

  // ── Unified turn loop ──────────────────────────────────────────────────
  while (true) {
    // Emit a turn-boundary marker to stdout for external drivers (e.g.
    // an LLM-player harness driving via --player-script-tail). Carries
    // the live transcript paths so the driver can read the player-view
    // file directly. Always-on; harmless in stdin / one-shot script modes.
    transcript.emitAwaitingMarker();
    const input = await playerSource.prompt("\n> ");
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/quit") {
      // Let pending bookkeeper writes land before we exit.
      await awaitPendingBookkeeper();
      console.log("\n[Thanks for playing!]");
      break;
    }

    if (lower === "/new" || lower === "/new-session") {
      if (!turnRunner.supportsSessionCommands) {
        console.log(
          `[${lower} not supported in Phase-1 split-agents mode. Use /quit and restart.]\n`
        );
        continue;
      }

      if (lower === "/new") {
        const confirmed = await confirmPrompt(
          playerSource,
          "This will wipe ALL state (scratchpad, character sheets, NPCs, factions) and start a new campaign. Continue?",
          false
        );
        if (!confirmed) {
          console.log("[Cancelled.]");
          continue;
        }
        // Flush in-flight writes before wiping state so we don't race the
        // bookkeeper writing into files we're about to delete.
        await awaitPendingBookkeeper();
        const removed = clearAllState(stateDir);
        console.log(
          `\n[Wiped: ${removed.length > 0 ? removed.join(", ") : "nothing to wipe"}]\n`
        );
        // clearAllState only deletes files directly in stateDir, so the
        // `transcripts/` subfolder (and its prior `.md` / `.jsonl` files)
        // is preserved across /new by design — an audit trail across
        // campaign resets, not state to wipe.
        transcript.resetForNewSession();
        transcript.beginSession({
          gameName: config.name,
          mode: "initial",
          seedLabel: seedModeLabel,
        });
        // Set to 0 so the next regular-loop input increments to 1 — the
        // "first turn after /new" is the player's next input, not /new
        // itself.
        turnNumber = 0;
        turnRunner.resetSession();

        // Show the pre-rendered opening (which already contains the
        // session-zero questions) and drop back to the input loop. No
        // LLM call here: the opening IS the LLM-call-equivalent
        // (pre-rendered by the characterizer at generate time). The
        // player's next input through the normal loop will be turn 1,
        // framed cold — the system prompt's "First contact" section
        // guides the agent on session-zero handling without us having
        // to pre-frame anything. This is the load-bearing property of
        // /new: it is a *user-side* command, not a turn the model
        // participates in. Matching that, /new produces no model call.
        //
        // Fallback for older runners with no openingMessage: a terse
        // status line so the player has *some* signal that the wipe
        // landed and the next input will start fresh. The model's
        // "First contact" section will still handle the actual greet.
        if (openingMessage) {
          console.log(`\n${openingMessage}\n`);
          transcript.recordFacilitatorChunk(openingMessage + "\n");
        } else {
          console.log("[New campaign — type anything to begin.]\n");
        }
        continue;
      }

      // /new-session — keep world state, drop the Claude session.
      await awaitPendingBookkeeper();
      clearSessionId(stateDir);
      console.log("\n[Cleared session-id; world state preserved.]\n");
      transcript.resetForNewSession();
      transcript.beginSession({
        gameName: config.name,
        mode: "fresh-session",
        seedLabel: seedModeLabel,
      });
      turnNumber += 1;
      turnRunner.resetSession();
      const res = await turnRunner.runTurn({
        userPrompt: freshSessionPrompt,
        turn: turnNumber,
      });
      enqueueBookkeeper({
        turnText: res.facilitatorText,
        turn: turnNumber,
        sessionId: res.sessionIdForTrace,
      });
      continue;
    }

    if (trimmed === "") continue;

    console.log("");

    // Before the facilitator starts reading books for turn N+1, make sure
    // turn N's bookkeeper has finished writing to them.
    await awaitPendingBookkeeper();

    transcript.recordPlayerInput(input);
    turnNumber += 1;
    const res = await turnRunner.runTurn({
      userPrompt: input,
      turn: turnNumber,
    });
    enqueueBookkeeper({
      turnText: `> ${input}\n\n${res.facilitatorText}`,
      turn: turnNumber,
      sessionId: res.sessionIdForTrace,
    });
  }

  await playerSource.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
