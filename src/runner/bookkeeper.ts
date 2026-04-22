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

export interface BookkeeperInvocation {
  /** The full text produced this turn — player input + facilitator output
   *  concatenated. The bookkeeper doesn't differentiate by speaker. */
  turnText: string;
  /** 1-indexed turn number within the session, for trace log correlation. */
  turn: number;
  gameContext: BookkeeperGameContext;
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

## Procedure on each call

1. Scan the turn text for any NAMED entities — NPCs, factions, PCs, or PC-like characters introduced or whose state changed.
2. For each named entity found:
   a. For a CLEAR first-introduction (the name is new to the fiction), just \`upsert\` directly with a one-line \`summary\` + any concrete fields the text supports. \`upsert\` creates-or-merges, so blind upserts of new entities work fine.
   b. For updates to an entity you suspect already exists: \`upsert\` with only the changed fields. If you're unsure whether a record exists (possible case mismatch, ambiguous naming), \`list\` first to confirm — but lean toward action over caution.
   c. If existing and nothing changed: skip.
3. For PCs (or PC-equivalent characters in games that don't use "PC" as a concept): during setup turns a new \`character_sheets\` record is typically created. Capture at minimum \`{name, concept}\`, plus any game-specific fields the text names (playbook, class, stats, goal, role, traits — whatever that game's character definition uses).

## Listing discipline

Avoid defensive listing. Every \`list\` call bloats the trace log for little signal. Prefer to:
- Upsert directly on clear first-introductions (the name is new in the turn text; no ambiguity).
- \`list\` only when you genuinely need to check — possible case-sensitivity drift, an ambiguous reference, or you're about to edit an existing record and want to see current fields via \`get\`.
- Skip all list calls on turns with no named entities (your SUMMARY line carries that signal).

## Rules

- **The "named" test is binary.** If they have a name, they get a record. Named figures of any role — officials, shopkeepers, rivals, allies, bystanders — all get records. Unnamed ("a guard", "the scientist") are skipped. Role-words used generically ("boss", "mother", "nonna") are skipped unless they're clearly being used as a proper name.
- **Do NOT invent details the turn text doesn't support.** If the text only says "Commander Vale appeared", record name + role (Commander). Don't invent their backstory, species, or appearance.
- **Names are case-sensitive.** Match existing records' casing; pick one canonical casing for new records and stick to it.
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
    `## Turn text`,
    ``,
    invocation.turnText,
    ``,
    `## Your task`,
    ``,
    `Identify any named entities in the turn text and upsert records for them as specified in your system prompt. If nothing named appears, do nothing and briefly say so.`,
  ]
    .filter(Boolean)
    .join("\n");
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
