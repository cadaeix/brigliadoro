/**
 * Player input abstraction for play.ts.
 *
 * A play session needs a source of player messages. The default source is
 * stdin (readline); the alternative is a scripted source that reads player
 * messages from a file. The play loop doesn't care which — it just calls
 * `prompt()` and gets a message back.
 *
 * This is deliberately narrow: the hook is input-only. It does not know
 * or care WHO or WHAT is producing the messages. A future "agentic player"
 * (Claude agent driving a persona) would plug in as a third source type
 * without changing the play loop. Personas / scenarios themselves live
 * outside the project.
 *
 * Script file format: NDJSON, one JSON object per line. Recognised shapes:
 *
 *   { "type": "message", "text": "I walk into the tavern" }
 *
 * Lines that fail to parse, don't have a recognised type, or lack a string
 * `text` field are skipped with a warning — this keeps the file tolerant
 * of comments or future extensions. Empty lines are ignored silently.
 *
 * On end-of-script, the source returns "/quit" so the play loop exits
 * cleanly (flushes transcripts, awaits the bookkeeper, closes readline).
 *
 * A second file-based variant is `createScriptTailSource`, which polls the
 * file for new lines after consuming the ones present at start-up. This
 * lets an external driver (human-in-terminal, Claude Code session, or a
 * full LLM-player harness) append turns one at a time while the runner is
 * live. Write a `{ "type": "quit" }` line to end the session cleanly.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export interface PlayerInputSource {
  /** Ask for the next player input. `promptText` is display hint only —
   *  stdin sources show it; scripted sources typically echo the response
   *  after it for observability parity. */
  prompt(promptText: string): Promise<string>;
  /** Release any resources (close readline, etc.). */
  close(): Promise<void>;
}

export function createStdinSource(rl: readline.Interface): PlayerInputSource {
  return {
    prompt(promptText) {
      return new Promise((resolve) => {
        rl.question(promptText, (answer) => resolve(answer));
      });
    },
    async close() {
      rl.close();
    },
  };
}

interface ScriptEntry {
  type: "message";
  text: string;
}

export function createScriptSource(filePath: string): PlayerInputSource {
  if (!fs.existsSync(filePath)) {
    throw new Error(`--player-script file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const queue: ScriptEntry[] = [];
  let lineNo = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      console.warn(
        `[player-script] line ${lineNo}: not valid JSON, skipping: ${line.slice(0, 80)}`
      );
      continue;
    }
    if (!obj || typeof obj !== "object") {
      console.warn(`[player-script] line ${lineNo}: not an object, skipping`);
      continue;
    }
    const rec = obj as Record<string, unknown>;
    const type = rec.type;
    const text = rec.text;
    if (type !== "message") {
      console.warn(
        `[player-script] line ${lineNo}: unknown type ${JSON.stringify(type)}, skipping`
      );
      continue;
    }
    if (typeof text !== "string") {
      console.warn(
        `[player-script] line ${lineNo}: "text" must be a string, skipping`
      );
      continue;
    }
    queue.push({ type: "message", text });
  }

  if (queue.length === 0) {
    throw new Error(
      `--player-script ${filePath} contained no usable messages`
    );
  }

  return {
    async prompt(promptText) {
      const next = queue.shift();
      if (!next) {
        // Script exhausted — tell the play loop to wrap up.
        process.stdout.write(`${promptText}/quit\n`);
        return "/quit";
      }
      // Echo the prompt text and the scripted response so terminal output
      // looks the same as a human-typed session (aids live observation).
      process.stdout.write(`${promptText}${next.text}\n`);
      return next.text;
    },
    async close() {
      // Nothing to clean up for file-based sources.
    },
  };
}

/**
 * Tail-mode script source. Reads lines from `filePath` as they appear,
 * polling at `pollMs` intervals (default 400ms). An external driver
 * appends one NDJSON line per turn; we consume lines in order and block
 * inside `prompt()` until a new line is available.
 *
 * Sentinel lines:
 *   { "type": "quit" }   — end the session (returns "/quit" to the loop)
 *
 * Malformed / unrecognised lines are skipped with a warning, same as
 * the non-tail variant.
 */
export function createScriptTailSource(
  filePath: string,
  options: { pollMs?: number } = {}
): PlayerInputSource {
  const pollMs = options.pollMs ?? 400;

  if (!fs.existsSync(filePath)) {
    // Create an empty file so the driver can start appending immediately.
    fs.writeFileSync(filePath, "");
  }

  let cursor = 0; // Index of the next line to consume (after filtering empties).

  function readAllLines(): string[] {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  function parseLine(
    line: string,
    lineIndex: number
  ): { kind: "message"; text: string } | { kind: "quit" } | { kind: "skip" } {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      console.warn(
        `[player-script-tail] line ${lineIndex + 1}: not valid JSON, skipping: ${line.slice(0, 80)}`
      );
      return { kind: "skip" };
    }
    if (!obj || typeof obj !== "object") {
      console.warn(`[player-script-tail] line ${lineIndex + 1}: not an object, skipping`);
      return { kind: "skip" };
    }
    const rec = obj as Record<string, unknown>;
    if (rec.type === "quit") return { kind: "quit" };
    if (rec.type !== "message") {
      console.warn(
        `[player-script-tail] line ${lineIndex + 1}: unknown type ${JSON.stringify(rec.type)}, skipping`
      );
      return { kind: "skip" };
    }
    if (typeof rec.text !== "string") {
      console.warn(
        `[player-script-tail] line ${lineIndex + 1}: "text" must be a string, skipping`
      );
      return { kind: "skip" };
    }
    return { kind: "message", text: rec.text };
  }

  async function waitForNext(): Promise<"quit" | string> {
    for (;;) {
      const lines = readAllLines();
      while (cursor < lines.length) {
        const parsed = parseLine(lines[cursor]!, cursor);
        cursor += 1;
        if (parsed.kind === "quit") return "quit";
        if (parsed.kind === "message") return parsed.text;
        // kind === "skip" — advance cursor and look at the next line.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    async prompt(promptText) {
      const next = await waitForNext();
      if (next === "quit") {
        process.stdout.write(`${promptText}/quit\n`);
        return "/quit";
      }
      process.stdout.write(`${promptText}${next}\n`);
      return next;
    },
    async close() {
      // Nothing to clean up for file-based sources.
    },
  };
}
