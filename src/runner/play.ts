/**
 * Generic play harness for Brigliadoro runners.
 *
 * This file is copied into each generated runner at build time.
 * It reads config.json, loads the game's MCP server, builds the
 * facilitator system prompt, and runs an interactive terminal play loop.
 *
 * Usage: npx tsx play.ts
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buildFacilitatorSystemPrompt } from "./lib/runner/facilitator-prompt-template.js";
import { createFacilitatorMemoryTools } from "./lib/runner/facilitator-memory.js";
import { createTranscriptWriter } from "./lib/runner/transcript.js";
import type { TranscriptWriter } from "./lib/runner/transcript.js";
import { runBookkeeper } from "./lib/runner/bookkeeper.js";
import type { BookSnapshot } from "./lib/runner/bookkeeper.js";
import { createSubagentTrace } from "./lib/runner/subagent-trace.js";
// Director/Narrator split-agent runtime (Phase 1, opt-in via --split-agents).
// See ~/.claude/plans/brigliadoro-director-narrator-split.md.
import { runDirector } from "./lib/runner/director.js";
import { runNarrator } from "./lib/runner/narrator.js";
import { DIRECTOR_PROMPT } from "./lib/runner/prompts/director.js";
import { NARRATOR_PROMPT } from "./lib/runner/prompts/narrator.js";
import {
  createScriptSource,
  createScriptTailSource,
  createStdinSource,
} from "./lib/runner/player-input.js";
import type { PlayerInputSource } from "./lib/runner/player-input.js";
import {
  streamSdkQuery,
  summariseToolInput,
} from "./lib/runner/sdk-utils.js";
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
  writeSessionId,
} from "./lib/runner/session-mode.js";
import {
  buildInitialPrompt,
  presentOpeningMessage,
} from "./lib/runner/opening-message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function promptPlayer(source: PlayerInputSource, prompt: string): Promise<string> {
  return source.prompt(prompt);
}

/**
 * Stream one monolith-facilitator query turn: print assistant text to
 * stdout, mirror facilitator text + tool-call indicators + tool-result
 * payloads to the transcript writer, return session_id + accumulated text.
 *
 * Tool results arrive in user-role messages keyed by tool_use_id;
 * `streamSdkQuery` resolves them to tool names internally so this function
 * sees a clean event stream.
 */
async function streamTurn(
  queryIter: AsyncIterable<Record<string, unknown>>,
  transcript: TranscriptWriter
): Promise<{ sessionId: string; facilitatorText: string }> {
  const summary = await streamSdkQuery(queryIter, {
    onText(text) {
      process.stdout.write(text);
      transcript.recordFacilitatorChunk(text);
    },
    onToolUse({ name, input }) {
      // Dim line showing the tool call so the player (and you,
      // debugging) can see the memory books and game tools firing
      // under the narration.
      const hint = summariseToolInput(input);
      process.stdout.write(`\n\x1b[2m  ↪ ${name}${hint}\x1b[0m\n`);
      transcript.recordToolCall(name, hint);
    },
    onToolResult({ name, text }) {
      // Don't print to stdout (would spam the game view); mirror to transcript.
      transcript.recordToolResult(name, text);
    },
    onResult({ subtype }) {
      if (subtype !== "success") {
        console.error(`\n[Facilitator agent ended with: ${subtype}]`);
      }
    },
  });

  // Ensure terminal output ends with newline; flush transcript turn too
  process.stdout.write("\n");
  transcript.endFacilitatorTurn(summary.sessionId);
  return { sessionId: summary.sessionId, facilitatorText: summary.text };
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
  const transcript = createTranscriptWriter(stateDir);

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

  // ── Phase-1 split-agent runtime ────────────────────────────────────────
  // When --split-agents is set, replace the monolithic facilitator with a
  // Director (planning + tool calls + brief) and a Narrator (voice + prose
  // from the brief). Two parallel sessions, two parallel sessionIds.
  //
  // Phase 1 simplifications:
  //   - No persistent sessionIds across runs (always starts fresh; no /resume)
  //   - /new, /new-session unsupported (use a fresh `npm run play` invocation)
  //   - Opening message + first-response capture is shared with monolith logic
  //
  // Plan: ~/.claude/plans/brigliadoro-director-narrator-split.md. Cutover to
  // default + full session-mode parity is Phase 4 of that plan.
  if (args.splitAgents) {
    console.log(
      "[--split-agents: Phase-1 runtime — Director + Narrator split. /resume, /new, /new-session not supported in this mode yet.]\n"
    );

    let directorSessionId: string | undefined;
    let narratorSessionId: string | undefined;

    async function runSplitTurn(
      playerInputForBrief: string,
      directorPromptText: string
    ): Promise<{ prose: string }> {
      const directorResult = await runDirector({
        prompt: directorPromptText,
        systemPrompt:
          DIRECTOR_PROMPT +
          `\n\n## Game-specific facilitator context\n\n` +
          `The system prompt below was authored for this specific game. It carries voice cues, principles, and tool-usage guidance you should treat as authoritative for game-specific framing. You — the Director — focus on the planning + brief side; the voice cues are most useful when populating brief.voice_hints and beat.intent.\n\n` +
          systemPrompt,
        gameServer,
        facilitatorServer,
        resumeSessionId: directorSessionId,
        model: "sonnet",
        transcript,
      });

      if (!directorResult.ok) {
        // Director didn't return a parseable brief. Phase-1 fallback: log
        // diagnostic, surface a degraded prose turn so the player sees
        // something rather than a silent hang.
        console.error(
          `\n[Director failed: ${directorResult.error}]\n` +
            `[Raw text was: ${directorResult.rawText.slice(0, 400)}…]\n`
        );
        if (directorResult.sessionId) directorSessionId = directorResult.sessionId;
        const degraded =
          "(The Director returned a malformed brief. " +
          "This is a Phase-1 split-agents bug worth reporting; for now, " +
          "try rephrasing or use a fresh terminal without --split-agents.)";
        console.log("\n" + degraded + "\n");
        transcript.recordFacilitatorChunk(degraded + "\n");
        transcript.endFacilitatorTurn(directorResult.sessionId ?? "");
        return { prose: degraded };
      }

      directorSessionId = directorResult.sessionId;

      const narratorResult = await runNarrator({
        brief: {
          ...directorResult.brief,
          // Always carry the player's verbatim input even if the Director
          // forgot to populate it.
          player_input:
            directorResult.brief.player_input || playerInputForBrief,
        },
        systemPrompt: NARRATOR_PROMPT,
        resumeSessionId: narratorSessionId,
        model: "sonnet",
        transcript,
      });

      narratorSessionId = narratorResult.sessionId;

      return { prose: narratorResult.prose };
    }

    // Opening message + first-response capture (mirrors the monolith path)
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
    const firstResponse =
      opening.kind === "responded" ? opening.text : undefined;

    transcript.beginSession({
      gameName: config.name,
      mode: "initial",
      seedLabel: seedModeLabel,
    });

    // First turn — frame as session-zero / initial greeting.
    turnNumber += 1;
    const firstPrompt = buildInitialPrompt({
      gameName: config.name,
      openingMessage,
      playerFirstResponse: firstResponse,
      playerPreferencesText,
    });
    const firstSplit = await runSplitTurn(
      firstResponse ?? "(no input — opening turn)",
      firstPrompt
    );
    enqueueBookkeeper({
      turnText:
        firstResponse !== undefined
          ? `> ${firstResponse}\n\n${firstSplit.prose}`
          : firstSplit.prose,
      turn: turnNumber,
      // Pass Director sessionId for trace correlation (Narrator's is
      // separate but the bookkeeper only needs one anchor).
      sessionId: directorSessionId ?? "",
    });

    // Turn loop — split-agent variant.
    while (true) {
      const input = await promptPlayer(playerSource, "\n> ");
      const trimmed = input.trim();
      const lower = trimmed.toLowerCase();

      if (lower === "/quit") {
        await awaitPendingBookkeeper();
        console.log("\n[Thanks for playing!]");
        break;
      }
      if (lower === "/new" || lower === "/new-session") {
        console.log(
          `[${lower} not supported in Phase-1 split-agents mode. Use /quit and restart.]\n`
        );
        continue;
      }
      if (trimmed === "") continue;

      console.log("");
      await awaitPendingBookkeeper();
      transcript.recordPlayerInput(input);
      turnNumber += 1;

      const split = await runSplitTurn(input, input);
      enqueueBookkeeper({
        turnText: `> ${input}\n\n${split.prose}`,
        turn: turnNumber,
        sessionId: directorSessionId ?? "",
      });
    }

    await playerSource.close();
    return;
  }

  // ── Monolith path (default) ────────────────────────────────────────────

  // Decide the first-turn mode. May print status banners and/or prompt the
  // player interactively (when there's a savedId and no forced flag).
  const { firstMode, resumeId } = await resolveSessionMode({
    stateDir,
    forced: args.sessionMode,
    playerSource,
  });

  if (resumeId) {
    console.log(`[Resuming session ${resumeId.slice(0, 8)}…]\n`);
  }
  transcript.beginSession({ gameName: config.name, mode: firstMode, seedLabel: seedModeLabel });

  // In initial mode, show the pre-rendered opening (if configured) and
  // capture the player's first response before the agent's first call.
  // Saves an LLM call and ensures a consistent first impression in the
  // characterizer-set voice. Resume / fresh-session modes skip the opening
  // — the player's been here before, no introduction needed.
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
  const firstResult = await streamTurn(
    query({
      prompt: firstPrompt,
      options: resumeId ? { ...sharedOptions, resume: resumeId } : sharedOptions,
    }),
    transcript
  );
  let sessionId = firstResult.sessionId;
  writeSessionId(stateDir, sessionId);
  enqueueBookkeeper({
    turnText:
      firstPlayerResponseAfterOpening !== undefined
        ? `> ${firstPlayerResponseAfterOpening}\n\n${firstResult.facilitatorText}`
        : firstResult.facilitatorText,
    turn: turnNumber,
    sessionId,
  });

  // Play loop
  while (true) {
    const input = await promptPlayer(playerSource, "\n> ");
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "/quit") {
      // Let pending bookkeeper writes land before we exit.
      await awaitPendingBookkeeper();
      console.log("\n[Thanks for playing!]");
      break;
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
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "initial", seedLabel: seedModeLabel });
      turnNumber = 1;

      // Mirror the initial-mode openingMessage flow on /new — same player
      // experience as a true first-time play.
      const newRunOpening = await presentOpeningMessage({
        openingMessage,
        playerSource,
        transcript,
      });
      if (newRunOpening.kind === "quit") {
        await awaitPendingBookkeeper();
        await playerSource.close();
        console.log("\n[Thanks for playing!]");
        return;
      }
      const newRunFirstResponse =
        newRunOpening.kind === "responded" ? newRunOpening.text : undefined;

      const newRunInitialPrompt = buildInitialPrompt({
        gameName: config.name,
        openingMessage,
        playerFirstResponse: newRunFirstResponse,
        playerPreferencesText,
      });

      const res = await streamTurn(
        query({
          prompt: newRunInitialPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      sessionId = res.sessionId;
      writeSessionId(stateDir, sessionId);
      enqueueBookkeeper({
        turnText:
          newRunFirstResponse !== undefined
            ? `> ${newRunFirstResponse}\n\n${res.facilitatorText}`
            : res.facilitatorText,
        turn: turnNumber,
        sessionId,
      });
      continue;
    }

    if (lower === "/new-session") {
      await awaitPendingBookkeeper();
      clearSessionId(stateDir);
      console.log("\n[Cleared session-id; world state preserved.]\n");
      transcript.resetForNewSession();
      transcript.beginSession({ gameName: config.name, mode: "fresh-session", seedLabel: seedModeLabel });
      turnNumber += 1;
      const res = await streamTurn(
        query({
          prompt: freshSessionPrompt,
          options: sharedOptions,
        }),
        transcript
      );
      sessionId = res.sessionId;
      writeSessionId(stateDir, sessionId);
      enqueueBookkeeper({
        turnText: res.facilitatorText,
        turn: turnNumber,
        sessionId,
      });
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    console.log("");

    // Before the facilitator starts reading books for turn N+1, make sure
    // turn N's bookkeeper has finished writing to them.
    await awaitPendingBookkeeper();

    transcript.recordPlayerInput(input);
    turnNumber += 1;
    const res = await streamTurn(
      query({
        prompt: input,
        options: {
          ...sharedOptions,
          resume: sessionId,
        },
      }),
      transcript
    );
    sessionId = res.sessionId;
    writeSessionId(stateDir, sessionId);
    enqueueBookkeeper({
      turnText: `> ${input}\n\n${res.facilitatorText}`,
      turn: turnNumber,
      sessionId,
    });
  }

  await playerSource.close();
}

main().catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
