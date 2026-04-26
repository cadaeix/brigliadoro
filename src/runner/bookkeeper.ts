/**
 * Bookkeeper subagent — a Haiku specialist that owns writes to the typed
 * memory books (npcs / factions / character_sheets).
 *
 * Invoked by play.ts after each facilitator turn. Reads the turn's text,
 * identifies named entities, upserts / updates records. The facilitator no
 * longer writes to the books — it only reads them for continuity.
 *
 * See `C:\Users\Cad\.claude\plans\bookkeeper-subagent.md` for the pattern.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentTrace, SubagentToolCall } from "./subagent-trace.js";

export interface BookkeeperGameContext {
  gameName: string;
  /** The in-game role the facilitator plays — "GM", "Lens", "Cardinal",
   *  whatever the characterizer picked. Passed for context only; the
   *  bookkeeper's extraction procedure doesn't depend on it. */
  facilitatorRole: string;
  /** Short premise / tone. ≤500 chars — enough to recognise setting-appropriate
   *  entity types without dumping full lore. */
  loreSummaryShort: string;
}

/** Compact snapshot of current book state, supplied to the bookkeeper at the
 *  start of each invocation. Maps record name → its one-line summary (or
 *  empty string if the record has no summary). The bookkeeper uses this to
 *  match-or-create against existing entries instead of defensively listing
 *  to discover them. Empty objects when a book is empty or absent. */
export interface BookSnapshot {
  npcs: Record<string, string>;
  factions: Record<string, string>;
  character_sheets: Record<string, string>;
}

export interface BookkeeperInvocation {
  /** The full text produced this turn — player input + facilitator output
   *  concatenated. The bookkeeper doesn't differentiate by speaker. */
  turnText: string;
  /** 1-indexed turn number within the session, for trace log correlation. */
  turn: number;
  gameContext: BookkeeperGameContext;
  /** Snapshot of book state as of right now, pre-supplied so the bookkeeper
   *  doesn't have to defensively list to learn what already exists. The
   *  bookkeeper uses this to canonicalise variant names against the existing
   *  keys (e.g. "Frankie" upserts onto an existing "Frankie 'Numbers' Delano"
   *  record rather than creating a new one). */
  bookSnapshot: BookSnapshot;
  /** Session id of the main play session. Used only for the trace filename
   *  — the bookkeeper itself runs as a fresh disconnected query. */
  sessionId: string;
}

export interface BookkeeperResult {
  summary: string;
  toolCalls: SubagentToolCall[];
  durationMs: number;
}

const INPUT_TEXT_TRUNCATE = 400;

export const BOOKKEEPER_PROMPT = `You are the Bookkeeper for a TTRPG runner. Your sole job is to keep the memory books (\`npcs\`, \`factions\`, \`character_sheets\`) accurate based on what happens in play.

You are called after each turn of the game. You receive:
- The text produced this turn (narration, dialogue, scene framing, player declarations — whatever the game's turn structure produces, from whichever participant produced it)
- A brief game context (game name, the facilitator's in-game role, one-line premise / tone)
- **A snapshot of current book state** — the names already in each book with their one-line summaries. This is your pre-loaded reference for canonicalising the names you see in the turn text.

## Response format (IMPORTANT)

The FIRST LINE of your response MUST be:

\`\`\`
SUMMARY: <one-line description of what you did this turn>
\`\`\`

Examples:
- \`SUMMARY: upserted npcs/Angelo Corvo (PC) and factions/Corvetti Family\`
- \`SUMMARY: updated npcs/Luca Corvetti with new disposition; no new entities\`
- \`SUMMARY: no named entities this turn\`

Follow the summary line with any reasoning / notes you want — those are read only for debug. The summary line is what gets logged to the transcript. Keep it under ~150 chars.

## Match-or-create against the supplied snapshot

The snapshot in your input is the source of truth for what records currently exist. Use it BEFORE making any tool call, to decide whether a name in the turn text is a *variant of an existing record* or a *genuinely new entity*. This is the most important rule the bookkeeper has, because the cost of getting it wrong is duplicate records that compound over a session.

A name in the turn text is a **variant** of an existing record when one or more of these holds:

- **Substring or superset.** The text says "Frankie" and the snapshot has "Frankie 'Numbers' Delano" — same person, the text is using the short form. The text says "Sal Torrino" and the snapshot has "Sal" — same person, the text added the surname.
- **Title difference.** The text says "Detective Vale" and the snapshot has "Vale" or "Commander Vale" — same person, just a title swap or addition.
- **Case-only difference.** "the broad in red" vs "The Broad in Red" — same entity, case drift only.
- **Punctuation / quoting variation.** \`Morrie the Crow\` vs \`"Morrie the Crow"\` vs \`Morrie\` — same character.
- **Common nickname mappings** that the text or snapshot makes obvious by context.

When you spot a variant: **upsert against the existing canonical key**, not the variant form. The canonical key is whichever name is already in the snapshot — you do not rename existing records to match the new variant; you upsert onto the existing key.

A name is **genuinely new** only when it has no plausible match in the snapshot. In that case: pick the most-canonical-feeling form available in the turn text (prefer the fullest form when both short and long appear in the same turn — "Sal Torrino" over "Sal") and upsert that as the new key.

When in doubt between "variant" and "new": prefer variant. A false-positive variant gets corrected by future text refining the record; a false-positive new record creates a permanent duplicate that pollutes the books for the rest of the session.

## Procedure on each call

1. Scan the turn text for any NAMED entities — NPCs, factions, PCs, or PC-like characters introduced or whose state changed.
2. For each named entity found:
   a. **Cross-reference against the snapshot.** Apply the match-or-create rules above. If the name is a variant of an existing record, prepare to upsert against the existing key.
   b. Upsert with only the changed or newly-introduced fields. \`upsert\` is create-or-merge for new entities and field-level merge for existing ones — both work without a prior \`get\`.
   c. If existing and nothing changed: skip.
3. For PCs (or PC-equivalent characters in games that don't use "PC" as a concept): during setup turns a new \`character_sheets\` record is typically created. Capture at minimum \`{name, concept}\`, plus any game-specific fields the text names (playbook, class, stats, goal, role, traits — whatever that game's character definition uses).

## Listing discipline

The snapshot replaces defensive listing. You should rarely if ever call \`list\` — the names you'd be listing are already in your input, with their summaries. Use \`list\` only when you genuinely suspect the snapshot is stale (which it shouldn't be — it's gathered immediately before you're invoked) or when you need to enumerate a long list of records you can already see in the snapshot.

\`get\` is still useful when you're about to update an existing record and want to see its current full fields (the snapshot only gives you summaries) — but only call it for records you're actually about to edit.

Skip all \`list\` and \`get\` calls on turns with no named entities (your SUMMARY line carries that signal).

## Rules

- **The "named" test is binary.** If they have a name, they get a record. Named figures of any role — officials, shopkeepers, rivals, allies, bystanders — all get records. Unnamed ("a guard", "the scientist") are skipped. Role-words used generically ("boss", "mother", "nonna") are skipped unless they're clearly being used as a proper name.
- **Do NOT invent details the turn text doesn't support.** If the text only says "Commander Vale appeared", record name + role (Commander). Don't invent their backstory, species, or appearance.
- **Names are case-sensitive at the storage layer**, but the variant-matching rule above means case-only differences should resolve to the existing key, not a new one.
- **Do not write to the scratchpad.** That is the facilitator's surface.
- **You have no text output the player will see.** Work is done via tool calls. The SUMMARY line goes to the debug log, not the player.

## What you have access to

You have the \`npcs\`, \`factions\`, and \`character_sheets\` MCP tools from the \`facilitator\` server. Each supports \`list\`, \`get\`, \`upsert\`, and \`remove\` operations. You do NOT have access to the scratchpad or any game-specific tools — just the three typed books.

Work quickly. SUMMARY line first, extraction pass, tool calls, done.`;

/**
 * Run one bookkeeper invocation. Spawns a fresh Haiku query() with access
 * only to the memory-book tools, extracts named entities from the turn,
 * and writes a trace-log entry. Resolves with the summary + tool-call log.
 */
export async function runBookkeeper(
  invocation: BookkeeperInvocation,
  facilitatorServer: McpServerConfig,
  trace: SubagentTrace
): Promise<BookkeeperResult> {
  const startedAt = Date.now();
  const toolCalls: SubagentToolCall[] = [];
  let summaryText = "";

  const userPrompt = buildUserPrompt(invocation);

  try {
    const iter = query({
      prompt: userPrompt,
      options: {
        systemPrompt: BOOKKEEPER_PROMPT,
        model: "haiku",
        mcpServers: { facilitator: facilitatorServer },
        // Scope: only the three typed-book tool names. Scratchpad, game
        // tools, built-ins — all excluded.
        allowedTools: [
          "mcp__facilitator__npcs",
          "mcp__facilitator__factions",
          "mcp__facilitator__character_sheets",
        ],
        tools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Bookkeeper is stateless per call; don't clutter session history.
        persistSession: false,
        // One round-trip is usually enough; cap to prevent runaway.
        maxTurns: 6,
      },
    });

    for await (const message of iter) {
      if (!("type" in message)) continue;
      if (message.type === "assistant" && "message" in message) {
        const msg = message.message as { content: Array<Record<string, unknown>> };
        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            summaryText += block.text;
          } else if (block.type === "tool_use") {
            const rawName = typeof block.name === "string" ? block.name : "";
            toolCalls.push({
              tool: stripMcpPrefix(rawName),
              args: block.input,
            });
          }
        }
      }
    }
  } catch (err) {
    summaryText = `[bookkeeper error] ${(err as Error).message ?? String(err)}`;
  }

  const durationMs = Date.now() - startedAt;
  const summary = extractSummary(summaryText);

  trace.append(invocation.sessionId, {
    turn: invocation.turn,
    subagent: "bookkeeper",
    input: {
      turnText: truncate(invocation.turnText, INPUT_TEXT_TRUNCATE),
      gameContext: invocation.gameContext,
    },
    toolCalls,
    summary,
    durationMs,
  });

  return { summary, toolCalls, durationMs };
}

function buildUserPrompt(invocation: BookkeeperInvocation): string {
  const { gameName, facilitatorRole, loreSummaryShort } = invocation.gameContext;
  return [
    `# Turn ${invocation.turn} — ${gameName}`,
    `Facilitator's in-game role: ${facilitatorRole}`,
    loreSummaryShort ? `Premise / tone: ${loreSummaryShort}` : "",
    ``,
    `## Current book state (canonical names — match against these before creating new records)`,
    ``,
    formatBookSnapshot(invocation.bookSnapshot),
    ``,
    `## Turn text`,
    ``,
    invocation.turnText,
    ``,
    `## Your task`,
    ``,
    `Identify any named entities in the turn text. For each, apply the match-or-create rule against the snapshot above before invoking any tool. Upsert against the existing canonical key when you spot a variant; create new only when the name has no plausible match. If nothing named appears, do nothing and briefly say so.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatBookSnapshot(snap: BookSnapshot): string {
  const sections: string[] = [];
  for (const [book, label] of [
    ["npcs", "npcs"],
    ["factions", "factions"],
    ["character_sheets", "character_sheets"],
  ] as const) {
    const records = snap[book];
    const entries = Object.entries(records);
    if (entries.length === 0) {
      sections.push(`### ${label}\n(empty)`);
      continue;
    }
    const lines = entries
      .map(([name, summary]) => {
        const trimmed = (summary ?? "").trim();
        return trimmed ? `- ${name} — ${trimmed}` : `- ${name}`;
      })
      .join("\n");
    sections.push(`### ${label}\n${lines}`);
  }
  return sections.join("\n\n");
}

/**
 * Extract the `SUMMARY: ...` line from the bookkeeper's response. The prompt
 * asks Haiku to lead with one. Fallback to a truncated trim of the raw text
 * so we still capture *something* if Haiku ignores the format.
 */
function extractSummary(text: string): string {
  const match = text.match(/^\s*SUMMARY:\s*(.+?)\s*$/m);
  if (match && match[1]) {
    const line = match[1].trim();
    return line.length > 200 ? line.slice(0, 200) + "…" : line;
  }
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}

function stripMcpPrefix(rawName: string): string {
  const parts = rawName.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") return parts.slice(2).join("__");
  return rawName;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
