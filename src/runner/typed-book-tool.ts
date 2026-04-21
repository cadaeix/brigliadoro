/**
 * Typed facilitator memory "book" — a structured scratchpad for named-entity records.
 *
 * Generic factory that produces an MCP tool with list/get/upsert/remove
 * over a single JSON file. Each book (npcs, factions, character_sheets)
 * is an instance with its own tool name, description, and record shape.
 *
 * Design notes:
 * - Load-on-every-call (no in-memory cache; tolerates external edits and
 *   parallel tool invocations cleanly).
 * - Atomic writes via tmp+rename so half-written JSON can't corrupt state.
 * - Per-file serialization via Promise-chain lock so concurrent upserts
 *   don't lose writes.
 * - Strict input schema. The `patch` shape is `z.object(recordShape).strict()`
 *   — unknown fields rejected. Record shape enforces closed enums + a
 *   `notes` markdown bucket per Report 2 §5.3.
 * - Case-sensitive names ("Elin" ≠ "elin"); documented in the description.
 * - Soft size warning on large records; does not reject.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

export interface TypedBookOptions<TShape extends z.ZodRawShape> {
  /** MCP tool name, e.g. "npcs". */
  name: string;
  /** Tool description. This is the trigger surface the facilitator reads — write carefully. */
  description: string;
  /** Filename under stateDir. e.g. "npcs.json". */
  filename: string;
  /** Zod raw shape for the record's structured fields.
   *  Every field should be .optional() and .describe()'d. Must NOT include `name`. */
  recordShape: TShape;
  /** Directory where the JSON file lives (the runner's state/ dir at runtime). */
  stateDir: string;
  /** Soft threshold for the serialized size of a single record, in bytes.
   *  Records above this size produce a warning in the upsert response (not rejected).
   *  Default 4096. */
  softRecordSizeBytes?: number;
}

type BookRecord = { [key: string]: unknown };
interface BookFile {
  records: { [name: string]: BookRecord };
}

type ReadResult =
  | { ok: true; book: BookFile }
  | { ok: false; reason: "corrupt"; detail: string };

function readBook(filePath: string): ReadResult {
  if (!fs.existsSync(filePath)) return { ok: true, book: { records: {} } };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    return { ok: false, reason: "corrupt", detail: `Read failed: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "corrupt", detail: `Invalid JSON: ${(e as Error).message}` };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("records" in parsed) ||
    typeof (parsed as { records: unknown }).records !== "object" ||
    (parsed as { records: unknown }).records === null
  ) {
    return {
      ok: false,
      reason: "corrupt",
      detail: "File did not contain a { records: {...} } object.",
    };
  }
  return { ok: true, book: parsed as BookFile };
}

function writeBookAtomic(filePath: string, book: BookFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

export function createTypedBookTool<TShape extends z.ZodRawShape>(
  opts: TypedBookOptions<TShape>
) {
  const filePath = path.join(opts.stateDir, opts.filename);
  const softSize = opts.softRecordSizeBytes ?? 4096;

  // Per-instance write lock: every mutating op chains through this promise
  // so concurrent upserts/removes don't race on the same file.
  let writeLock: Promise<unknown> = Promise.resolve();
  function withLock<R>(fn: () => Promise<R>): Promise<R> {
    const gate = writeLock.catch(() => undefined);
    const next = gate.then(fn);
    writeLock = next.catch(() => undefined);
    return next;
  }

  const patchSchema = z.object(opts.recordShape).strict();

  return tool(
    opts.name,
    opts.description,
    {
      operation: z
        .enum(["list", "get", "upsert", "remove"])
        .describe(
          "list: names + one-line summaries across all records. get: full record for a name. upsert: create a record, or shallow-merge a patch into an existing one (arrays replace wholesale). remove: delete a record."
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Record name. Required for get/upsert/remove. Case-sensitive — 'Elin' and 'elin' are different records."
        ),
      patch: patchSchema
        .optional()
        .describe(
          "Fields to set for upsert. Only provided fields are updated; unmentioned fields are preserved. Arrays replace wholesale. Omit for list/get/remove."
        ),
    },
    async ({ operation, name, patch }) => {
      const corruptResult = (detail: string) => ({
        content: [
          { type: "text" as const, text: `Error reading ${opts.name} store: ${detail}` },
        ],
        structuredContent: { error: "corrupt_store", detail },
        isError: true,
      });

      // list — read-only, no lock needed.
      if (operation === "list") {
        const read = readBook(filePath);
        if (!read.ok) return corruptResult(read.detail);
        const entries = Object.entries(read.book.records).map(([n, r]) => ({
          name: n,
          summary: typeof r.summary === "string" ? (r.summary as string) : null,
        }));
        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${opts.name}: empty. Use 'upsert' with a name and patch to create a record.`,
              },
            ],
            structuredContent: { operation, entries: [] },
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
          structuredContent: { operation, entries },
        };
      }

      // get — read-only.
      if (operation === "get") {
        if (!name) {
          return {
            content: [{ type: "text" as const, text: `Error: 'name' is required for get.` }],
            structuredContent: { error: "missing_name" },
            isError: true,
          };
        }
        const read = readBook(filePath);
        if (!read.ok) return corruptResult(read.detail);
        const record = read.book.records[name];
        if (!record) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${opts.name} record named "${name}".`,
              },
            ],
            structuredContent: { error: "not_found", name },
            isError: true,
          };
        }
        const full = { name, ...record };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(full, null, 2) }],
          structuredContent: { operation, name, record: full },
        };
      }

      // Mutating ops — serialize via the lock.
      return withLock(async () => {
        if (operation === "upsert") {
          if (!name) {
            return {
              content: [
                { type: "text" as const, text: `Error: 'name' is required for upsert.` },
              ],
              structuredContent: { error: "missing_name" },
              isError: true,
            };
          }
          if (!patch) {
            return {
              content: [
                { type: "text" as const, text: `Error: 'patch' is required for upsert.` },
              ],
              structuredContent: { error: "missing_patch" },
              isError: true,
            };
          }
          const read = readBook(filePath);
          if (!read.ok) return corruptResult(read.detail);
          const existing = read.book.records[name] ?? {};
          const merged: BookRecord = { ...existing, ...(patch as BookRecord) };
          read.book.records[name] = merged;
          writeBookAtomic(filePath, read.book);

          const full = { name, ...merged };
          const size = Buffer.byteLength(JSON.stringify(full), "utf-8");
          const oversized = size > softSize;
          const warning = oversized
            ? `Warning: record is ${size} bytes (> soft cap ${softSize}). Consider summarising older content in 'notes' and pruning.`
            : undefined;

          return {
            content: [
              {
                type: "text" as const,
                text: `Upserted ${opts.name}:${name}.${warning ? " " + warning : ""}`,
              },
            ],
            structuredContent: { operation, name, record: full, warning },
          };
        }

        if (operation === "remove") {
          if (!name) {
            return {
              content: [
                { type: "text" as const, text: `Error: 'name' is required for remove.` },
              ],
              structuredContent: { error: "missing_name" },
              isError: true,
            };
          }
          const read = readBook(filePath);
          if (!read.ok) return corruptResult(read.detail);
          if (!(name in read.book.records)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No ${opts.name} record named "${name}" to remove.`,
                },
              ],
              structuredContent: { error: "not_found", name },
              isError: true,
            };
          }
          delete read.book.records[name];
          writeBookAtomic(filePath, read.book);
          return {
            content: [{ type: "text" as const, text: `Removed ${opts.name}:${name}.` }],
            structuredContent: { operation, name, removed: true },
          };
        }

        // Unreachable — TS enum is exhaustive. Return an error shape rather than throw
        // so the tool loop sees a recoverable error.
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown operation: ${String(operation)}`,
            },
          ],
          structuredContent: { error: "unknown_operation", operation },
          isError: true,
        };
      });
    }
  );
}
