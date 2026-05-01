/**
 * Schema for the Director-to-Narrator brief.
 *
 * The Director (planning + tool calls + state) produces a NarratorBrief
 * each turn; the Narrator (voice + prose) consumes it and writes the
 * player-facing turn. The brief is the runtime equivalent of what
 * `tools/manifest.json` is for generation: the typed interface that
 * makes the split structurally meaningful rather than two LLMs in a
 * trench coat.
 *
 * Design intent (from the Director/Narrator plan):
 *
 * - The brief is what makes "narrate around the dice" structurally
 *   impossible. The Narrator only sees what the Director has decided
 *   already happened (tool_result populated, dice already rolled). The
 *   Narrator can't author complications because by its turn the
 *   complications have been decided.
 *
 * - Voice hints are scoped per-turn: the persona is constant per session,
 *   but tone and intensity can shift between scenes. The Director picks
 *   intensity based on the beat ("low" for downtime, "high" for climaxes).
 *
 * - Constraints are derived from persona + player preferences. They make
 *   "the Narrator must not speak for the PC" a structural rule rather
 *   than a prose request.
 *
 * - Excerpts are the Narrator's window into state. The Narrator does not
 *   read books or scratchpad directly — the Director curates what's
 *   needed into the brief. This keeps the Narrator's context narrow and
 *   forces it to honor the Director's plan rather than freelancing on
 *   information the Director didn't intend to surface.
 *
 * Phase-1 scope: schema + harness only. Personas are mostly placeholder
 * here; the persona library (separate plan) will populate
 * voice_hints.persona with real values and the Director will pick intent
 * fields shaped by the persona's stance.
 */

import { z } from "zod";

/**
 * Beat kind — what the Director is asking the Narrator to do this turn.
 *
 * - `scene_setup` — establish a new scene (location, atmosphere, NPCs present).
 *   Typically used at the start of a session, after a transition, or when
 *   the player enters somewhere new.
 * - `action_outcome` — narrate the result of a tool call. The dice have
 *   spoken; the Narrator translates the outcome into voice.
 * - `complication` — narrate a complication that emerged from a tool call
 *   (e.g. a flag returned by the resolution tool, or a Boss-action via
 *   spend_thorns). Distinct from action_outcome because complications can
 *   land turns later than the action that generated them.
 * - `transition` — bridge between scenes. Time passing, location changing,
 *   "later that night," etc.
 * - `npc_response` — voice an NPC reacting to the player's input. Used
 *   when the player addresses or affects an NPC and the response is
 *   primarily that NPC's voice/reaction.
 * - `player_query` — the Director needs to ask the player something
 *   in-voice (a clarifying question, a pausable-tool prompt like "push
 *   or stop?", a session-zero question).
 * - `session_zero` — first-turn introduction or character creation flow.
 * - `end_of_turn` — the Director has nothing mechanically to add; the
 *   Narrator should produce a small in-voice acknowledgement / breathing
 *   space and hand back to the player.
 */
export const BeatKindSchema = z.enum([
  "scene_setup",
  "action_outcome",
  "complication",
  "transition",
  "npc_response",
  "player_query",
  "session_zero",
  "end_of_turn",
]);
export type BeatKind = z.infer<typeof BeatKindSchema>;

/**
 * Persona identifier. Phase-1 default is `"default"` (cooperative-play
 * baseline) because the persona library hasn't shipped yet. Adding the
 * five named personas now so the schema doesn't churn when the library
 * lands. See `~/.claude/plans/brigliadoro-persona-library.md`.
 */
export const PersonaSchema = z.enum([
  "default",
  "fan",
  "adversary",
  "referee",
  "author",
  "co_discoverer",
  "improv_partner",
]);
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * What the Director has decided mechanically happened this turn. Carries
 * the tool result if a tool was called; the Narrator narrates *this*
 * outcome rather than authoring its own.
 *
 * `outcome_tier` is the structured signal — same vocabulary the tools
 * already emit. `salient_facts` and `suggested_beats` come from the
 * tool's hint return. `flags` is game-specific — the Narrator interprets
 * them via persona/voice context.
 */
export const ToolResultSchema = z.object({
  tool_name: z
    .string()
    .min(1)
    .describe("MCP tool name that produced this outcome (e.g. 'risky_action')."),
  outcome_tier: z
    .string()
    .min(1)
    .describe("The tier value from the tool's outcome (e.g. 'clean', 'bent', 'screwed_up', 'generated')."),
  pressure: z
    .string()
    .optional()
    .describe("The 'pressure' hint from the tool, if any (e.g. 'rising', 'spiking', 'releasing')."),
  salient_facts: z
    .array(z.string())
    .describe(
      "Tokens from the tool's salient_facts return — terse facts the Narrator should weave in. " +
        "E.g. ['thorns:boss:+2', 'highest_die:4']."
    ),
  suggested_beats: z
    .array(z.string())
    .describe("Tokens from the tool's suggested_beats return — beat-shape hints (e.g. ['complication'])."),
  flags: z
    .record(z.unknown())
    .describe("Game-specific flag values from the tool return. The Narrator interprets these via the persona prompt."),
  raw_record: z
    .unknown()
    .optional()
    .describe(
      "The full tool return for posterity / future reference. The Narrator should usually ignore this and " +
        "rely on the structured fields above."
    ),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * The beat the Director wants the Narrator to convey. `summary` is the
 * Director's structured account of what's happening; `intent` is what
 * the Narrator should accomplish in voice.
 */
export const BeatSchema = z.object({
  kind: BeatKindSchema,
  summary: z
    .string()
    .min(1)
    .describe(
      "The Director's structured account of what's happening this turn. " +
        "Plain prose, no voice — the Narrator handles voice."
    ),
  intent: z
    .string()
    .min(1)
    .describe(
      "What the Narrator should accomplish — e.g. 'reveal that the cipher is broken', " +
        "'voice Silverhand suspicious', 'set the dock scene cold and gray', 'ask the player whether to push or stop'."
    ),
});
export type Beat = z.infer<typeof BeatSchema>;

/**
 * Voice hints for this specific turn. The persona is constant per session;
 * tone and intensity vary per beat.
 */
export const VoiceHintsSchema = z.object({
  persona: PersonaSchema,
  tone: z
    .string()
    .min(1)
    .describe(
      "Free-form per-turn tone — 'tense', 'quiet', 'absurd', 'foreboding', 'playful', etc. " +
        "The Narrator uses this to colour register without overriding the persona's baseline voice."
    ),
  intensity: z
    .enum(["low", "medium", "high"])
    .describe(
      "How dialed up the voice should be. Low for downtime / breathing. Medium for normal beats. " +
        "High for climaxes / reveals / failures with teeth."
    ),
});
export type VoiceHints = z.infer<typeof VoiceHintsSchema>;

/**
 * Constraints on what the Narrator may or may not do this turn.
 *
 * Some constraints derive from persona (Adversary may forbid narrative
 * gifts to the PC); some from player preferences (a player may forbid
 * the facilitator from speaking dialogue for their PC); some from
 * per-turn judgement by the Director (don't reveal that NPC X is the
 * traitor yet).
 */
export const NarratorConstraintsSchema = z.object({
  may_voice_pc_dialogue: z
    .boolean()
    .describe(
      "If false, the Narrator must not put words in the PC's mouth. The PC's actions can be described, " +
        "but their direct speech is the player's prerogative."
    ),
  may_describe_pc_internal_state: z
    .boolean()
    .describe(
      "If false, the Narrator must not describe the PC's thoughts, feelings, or sensations beyond what " +
        "the player has explicitly said."
    ),
  may_introduce_new_npcs: z
    .boolean()
    .describe(
      "If false, the Narrator must not introduce NPCs that aren't already in the brief's relevant_npcs " +
        "list or in canonical state. Prevents Narrator-side world drift."
    ),
  forbidden_phrases: z
    .array(z.string())
    .optional()
    .describe(
      "Specific phrases the Narrator must not use this turn. Used sparingly (e.g. to avoid leaking a " +
        "twist the Director isn't ready to reveal)."
    ),
  required_callbacks: z
    .array(z.string())
    .optional()
    .describe(
      "Things the Narrator should weave in. E.g. 'mention Ashleigh's growing suspicion', " +
        "'Thorn count 2 visible to player'."
    ),
});
export type NarratorConstraints = z.infer<typeof NarratorConstraintsSchema>;

/**
 * Excerpts from state the Narrator might need. Curated by the Director
 * — the Narrator does not read books / scratchpad directly.
 */
export const NarratorExcerptsSchema = z.object({
  pc_state: z
    .record(z.unknown())
    .optional()
    .describe(
      "Just the PC fields the Narrator needs (name, current Thorns, current Fades visible to player, etc.). " +
        "Not the full character sheet."
    ),
  relevant_npcs: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
      })
    )
    .describe(
      "NPCs the Narrator may voice or describe this turn, with brief summaries. The Narrator must not " +
        "introduce NPCs outside this list (subject to may_introduce_new_npcs)."
    ),
  scene_setting: z
    .string()
    .optional()
    .describe(
      "Where we are physically — Director writes once per scene change so the Narrator has anchor for " +
        "atmospheric detail. Stays the same across turns within a scene."
    ),
});
export type NarratorExcerpts = z.infer<typeof NarratorExcerptsSchema>;

/**
 * The complete brief. The Director's final response each turn is a
 * single JSON object validating against this schema.
 */
export const NarratorBriefSchema = z.object({
  tool_result: ToolResultSchema
    .optional()
    .describe(
      "Set when this turn included a tool call. Omit when the turn is purely scene-setting / dialogue / " +
        "transition without a mechanical resolution."
    ),
  beat: BeatSchema,
  voice_hints: VoiceHintsSchema,
  constraints: NarratorConstraintsSchema,
  excerpts: NarratorExcerptsSchema,
  player_input: z
    .string()
    .describe(
      "The player's most recent input verbatim. The Narrator uses this to address the player in voice " +
        "and to acknowledge what they said."
    ),
});
export type NarratorBrief = z.infer<typeof NarratorBriefSchema>;

/**
 * Parse and validate a brief from a JSON string. Returns either a typed
 * brief or a structured error suitable for the harness to surface as
 * "Director returned malformed brief — re-running" or similar.
 */
export function parseNarratorBrief(
  rawJson: string
): { ok: true; brief: NarratorBrief } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      ok: false,
      error: `Narrator brief is not valid JSON: ${(e as Error).message}`,
    };
  }
  const result = NarratorBriefSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Narrator brief failed schema validation:\n${result.error.toString()}`,
    };
  }
  return { ok: true, brief: result.data };
}
