/**
 * Session-mode resolution + state-directory helpers for the runner.
 *
 * "Session mode" is the first-turn framing for an agent invocation:
 *   - `initial` — fresh world, no prior state. Greet from scratch.
 *   - `fresh-session` — world state preserved (scratchpad, books, etc.)
 *     but a new Claude session id. Reorient via `list` calls before
 *     responding.
 *   - `resume` — continue an existing Claude session via `resume:` on
 *     the SDK options, picking up where the agent left off.
 *
 * `resolveSessionMode` decides which of the three to use based on CLI
 *  flags and any saved-session-id pointer on disk; for the default
 *  no-flag case with a saved session present, it consults the player
 *  interactively.
 *
 * The state-dir helpers (`readSavedSessionId`, `writeSessionId`,
 * `clearAllState`, `clearSessionId`) are exported so the runtime
 * `/new` / `/new-session` command handlers in play.ts can reuse them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlayerInputSource } from "./player-input.js";
import type { SessionModeArg } from "./cli-args.js";

export type FirstMode = "resume" | "fresh-session" | "initial";

export interface ResolveSessionModeOptions {
  stateDir: string;
  /** Forced session mode from CLI args, or undefined for default
   *  behaviour (interactive savedId prompt or initial). */
  forced: SessionModeArg;
  /** Player source for the interactive "Saved session found. Resume?"
   *  prompt. Only consulted when `forced` is undefined and a saved
   *  session-id is present. */
  playerSource: PlayerInputSource;
}

export interface SessionModeResolution {
  firstMode: FirstMode;
  /** When `firstMode === "resume"`, the session id to pass to the SDK's
   *  `resume` option. Undefined otherwise. */
  resumeId: string | undefined;
}

/**
 * Decide first-turn mode + resume id. Prints log lines to console as
 * side effects (status banners for --new wipes, etc.) and may prompt the
 * player interactively for the default no-flag-with-savedId case.
 */
export async function resolveSessionMode(
  opts: ResolveSessionModeOptions
): Promise<SessionModeResolution> {
  const { stateDir, forced, playerSource } = opts;
  const savedId = readSavedSessionId(stateDir);

  if (forced === "new") {
    const removed = clearAllState(stateDir);
    console.log(
      `[--new: ${removed.length > 0 ? `wiped ${removed.join(", ")}` : "no state to wipe"}]\n`
    );
    return { firstMode: "initial", resumeId: undefined };
  }

  if (forced === "new-session") {
    if (clearSessionId(stateDir)) {
      console.log(
        "[--new-session: cleared session-id; world state preserved]\n"
      );
    } else {
      console.log(
        "[--new-session: no prior session; world state preserved]\n"
      );
    }
    return { firstMode: "fresh-session", resumeId: undefined };
  }

  if (forced === "resume") {
    if (savedId) {
      return { firstMode: "resume", resumeId: savedId };
    }
    console.log("[--resume: no saved session found; starting fresh]\n");
    return { firstMode: "initial", resumeId: undefined };
  }

  // No forced mode — default behaviour.
  if (savedId) {
    const wantResume = await confirmPrompt(
      playerSource,
      "Saved session found. Resume?",
      true
    );
    console.log("");
    if (wantResume) {
      return { firstMode: "resume", resumeId: savedId };
    }
    // Declined resume — keep world state, start a fresh Claude session.
    clearSessionId(stateDir);
    return { firstMode: "fresh-session", resumeId: undefined };
  }

  return { firstMode: "initial", resumeId: undefined };
}

// ── State-directory helpers ─────────────────────────────────────────────

/** Read the saved Claude session-id pointer; undefined if missing or
 *  unreadable. */
export function readSavedSessionId(stateDir: string): string | undefined {
  const p = path.join(stateDir, "session-id.txt");
  if (!fs.existsSync(p)) return undefined;
  try {
    const id = fs.readFileSync(p, "utf-8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/** Write the Claude session-id pointer atomically (mkdir -p first). */
export function writeSessionId(stateDir: string, id: string): void {
  if (!id) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "session-id.txt"), id, "utf-8");
}

/** Delete every file directly in stateDir (preserves the dir itself).
 *  Returns the names of files actually removed for status reporting. */
export function clearAllState(stateDir: string): string[] {
  if (!fs.existsSync(stateDir)) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(stateDir)) {
    const p = path.join(stateDir, entry);
    try {
      if (fs.statSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(entry);
      }
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Delete just the session-id pointer; preserves scratchpad, books, etc.
 *  Returns true if a session-id file existed and was removed. */
export function clearSessionId(stateDir: string): boolean {
  const p = path.join(stateDir, "session-id.txt");
  if (!fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Y/N prompt with default. Used by `resolveSessionMode` for the resume
 * confirmation and by the runtime `/new` confirmation in play.ts. Empty
 * input falls back to the default; "y"/"yes" (case-insensitive) is yes;
 * anything else is no.
 */
export async function confirmPrompt(
  source: PlayerInputSource,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await source.prompt(`${question} ${suffix} `))
    .trim()
    .toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}
