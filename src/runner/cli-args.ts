/**
 * Runner CLI argument parsing.
 *
 * Two-phase design:
 *   1. `parseRunnerArgs(argv)` — pure parsing into a typed result. No I/O,
 *      no monkey-patches, no process.exit. Returns `{ ok: true, args }` or
 *      `{ ok: false, error }` so the caller decides how to surface errors.
 *   2. `applySeedMode(args.seedMode)` — installs the deterministic-RNG
 *      monkey-patch when seed mode is requested. Must be called BEFORE
 *      the game server's module is dynamically imported, since tool
 *      factories may touch `Math.random` during construction.
 *   3. `loadPlayerPreferences(path)` — reads the markdown preferences
 *      file. Throws on missing / unreadable / empty file; caller surfaces
 *      the message and decides whether to exit.
 *
 * Lives in `src/runner/` so it ships into every generated runner via the
 * existing dist-copy step in `meta/run.ts`.
 */
import * as fs from "node:fs";
import {
  installSeededRng,
  installSequenceRng,
  parseSequenceArg,
} from "./seeded-rng.js";

/** Forced session mode from CLI flags. `undefined` = default behaviour
 *  (interactive savedId prompt or initial). */
export type SessionModeArg = "new" | "new-session" | "resume" | undefined;

/**
 * Seed-mode configuration. Applied via `applySeedMode` to monkey-patch
 * `Math.random` for deterministic dice / table rolls.
 *
 * `label` is a short human-readable description used in transcript
 * headers and the seed-mode banner line.
 */
export type SeedModeArg =
  | { kind: "seed"; value: number; label: string }
  | { kind: "sequence"; values: number[]; label: string };

export interface RunnerArgs {
  /** Forced session mode, or undefined for default behaviour. Mutually
   *  exclusive at parse time — passing more than one flag is an error. */
  sessionMode: SessionModeArg;
  /** Opt-in Director/Narrator split runtime (Phase 1, `--split-agents`). */
  splitAgents: boolean;
  /** Seed-mode config, or undefined for normal RNG. Mutually exclusive
   *  between `--seed=N` and `--rng-sequence=v1,v2,…`. */
  seedMode: SeedModeArg | undefined;
  /** Path to NDJSON player-script file (one-shot mode). Mutually exclusive
   *  with `playerScriptTailPath`. */
  playerScriptPath: string | undefined;
  /** Path to NDJSON player-script-tail file (live-driven mode — block on
   *  appended lines until a `{"type":"quit"}` sentinel). */
  playerScriptTailPath: string | undefined;
  /** Path to markdown file with pre-baked session-zero answers. The
   *  facilitator skips the universal questions covered by these. */
  playerPreferencesPath: string | undefined;
}

export type ParsedArgs =
  | { ok: true; args: RunnerArgs }
  | { ok: false; error: string };

/**
 * Parse `process.argv.slice(2)` into a typed `RunnerArgs`. Returns an
 * error result for invalid combinations or malformed flag values; never
 * throws, never logs, never exits.
 */
export function parseRunnerArgs(argvRaw: string[]): ParsedArgs {
  // ── Seed-mode flags ─────────────────────────────────────────────────
  const seedArg = argvRaw.find((a) => a.startsWith("--seed="));
  const sequenceArg = argvRaw.find((a) => a.startsWith("--rng-sequence="));
  if (seedArg && sequenceArg) {
    return {
      ok: false,
      error: "Error: --seed and --rng-sequence are mutually exclusive.",
    };
  }
  let seedMode: SeedModeArg | undefined;
  if (seedArg) {
    const raw = seedArg.slice("--seed=".length).trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return {
        ok: false,
        error: `Error: --seed requires an integer value, got: ${raw || "<empty>"}`,
      };
    }
    seedMode = { kind: "seed", value: n, label: `seed=${n}` };
  } else if (sequenceArg) {
    const raw = sequenceArg.slice("--rng-sequence=".length);
    try {
      const values = parseSequenceArg(raw);
      seedMode = {
        kind: "sequence",
        values,
        label: `scripted (${values.length} values)`,
      };
    } catch (err) {
      return { ok: false, error: `Error: ${(err as Error).message}` };
    }
  }

  // ── Session-mode flags ──────────────────────────────────────────────
  const forceNew = argvRaw.includes("--new");
  const forceNewSession = argvRaw.includes("--new-session");
  const forceResume = argvRaw.includes("--resume");
  const modeCount = [forceNew, forceNewSession, forceResume].filter(Boolean)
    .length;
  if (modeCount > 1) {
    return {
      ok: false,
      error: "Error: --new, --new-session, and --resume are mutually exclusive.",
    };
  }
  const sessionMode: SessionModeArg = forceNew
    ? "new"
    : forceNewSession
    ? "new-session"
    : forceResume
    ? "resume"
    : undefined;

  // ── Opt-in Director/Narrator split ──────────────────────────────────
  const splitAgents = argvRaw.includes("--split-agents");

  // ── Player-source script flags ──────────────────────────────────────
  const scriptArg = argvRaw.find((a) => a.startsWith("--player-script="));
  const scriptTailArg = argvRaw.find((a) =>
    a.startsWith("--player-script-tail=")
  );
  if (scriptArg && scriptTailArg) {
    return {
      ok: false,
      error:
        "Specify only one of --player-script=FILE or --player-script-tail=FILE.",
    };
  }
  const playerScriptPath = scriptArg
    ? scriptArg.slice("--player-script=".length).trim()
    : undefined;
  const playerScriptTailPath = scriptTailArg
    ? scriptTailArg.slice("--player-script-tail=".length).trim()
    : undefined;

  // ── Player preferences file ─────────────────────────────────────────
  const preferencesArg = argvRaw.find((a) =>
    a.startsWith("--player-preferences=")
  );
  const playerPreferencesPath = preferencesArg
    ? preferencesArg.slice("--player-preferences=".length).trim()
    : undefined;

  return {
    ok: true,
    args: {
      sessionMode,
      splitAgents,
      seedMode,
      playerScriptPath,
      playerScriptTailPath,
      playerPreferencesPath,
    },
  };
}

/**
 * Install the deterministic-RNG monkey-patch and emit the seed-mode
 * banner. No-op when `seedMode` is undefined.
 *
 * Must be called before the game server's module is dynamically imported —
 * tool factories may touch `Math.random` at construction time.
 */
export function applySeedMode(seedMode: SeedModeArg | undefined): void {
  if (!seedMode) return;
  if (seedMode.kind === "seed") {
    installSeededRng(seedMode.value);
    console.log(
      `[seed mode: ${seedMode.label} — Math.random is deterministic]`
    );
  } else {
    installSequenceRng(seedMode.values);
    console.log(
      `[seed mode: ${seedMode.label} — Math.random cycles through the given values]`
    );
  }
}

/**
 * Read a markdown player-preferences file. Throws with a caller-friendly
 * message on missing / unreadable / empty file; caller decides whether to
 * surface and exit.
 */
export function loadPlayerPreferences(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`--player-preferences file not found: ${filePath}`);
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8").trim();
  } catch (e) {
    throw new Error(
      `reading --player-preferences file: ${(e as Error).message}`
    );
  }
  if (!text) {
    throw new Error(`--player-preferences file is empty: ${filePath}`);
  }
  return text;
}
