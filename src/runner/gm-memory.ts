/**
 * GM memory surfaces — scratchpad + typed books.
 *
 * Bundles the four memory tools the GM agent uses to remember across
 * sessions: the existing freeform scratchpad plus three typed books for
 * named entities (NPCs, factions, the PC(s)).
 *
 * Registered in play.ts as the "gm-tools" MCP server.
 */
import { z } from "zod";
import { createScratchpadTool } from "./scratchpad-tool.js";
import { createTypedBookTool } from "./typed-book-tool.js";

const DISPOSITION_ENUM = [
  "friendly",
  "neutral",
  "suspicious",
  "hostile",
  "unknown",
] as const;

// Shared across all books: the free-text markdown bucket where
// unstructured evolution lives.
const notesField = z
  .string()
  .optional()
  .describe("Freeform markdown notes. Use for anything that doesn't fit the structured fields.");

const summaryField = z
  .string()
  .max(200)
  .optional()
  .describe("One-line identity, under ~100 chars. Shown in the `list` view. Keep it crisp.");

const npcsShape = {
  summary: summaryField,
  role: z
    .string()
    .optional()
    .describe("What they do in the fiction — e.g. 'dockmaster', 'rival smuggler', 'Consortium envoy'."),
  disposition: z
    .enum(DISPOSITION_ENUM)
    .optional()
    .describe("Current stance toward the PC(s). One of: friendly, neutral, suspicious, hostile, unknown."),
  location: z
    .string()
    .optional()
    .describe("Where they were last known to be."),
  last_seen: z
    .string()
    .optional()
    .describe("Brief reference to the scene/session they last appeared in — e.g. 'session 3 at the gala'."),
  tags: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Short keyword tags for cross-reference. Up to 10."),
  notes: notesField,
} as const;

const factionsShape = {
  summary: summaryField,
  type: z
    .enum(["government", "guild", "cult", "criminal", "military", "other"])
    .optional()
    .describe("Kind of organisation. One of: government, guild, cult, criminal, military, other."),
  disposition_to_pc: z
    .enum(DISPOSITION_ENUM)
    .optional()
    .describe("Current stance toward the PC(s). Same enum as npcs.disposition."),
  goals: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Active goals the faction is pursuing. Up to 10. Replaces wholesale on upsert."),
  notes: notesField,
} as const;

const characterSheetsShape = {
  summary: summaryField,
  pronouns: z.string().optional().describe("e.g. 'she/her', 'they/them'."),
  concept: z
    .string()
    .optional()
    .describe("High-level character concept — a sentence or two capturing who they are."),
  playbook: z
    .string()
    .optional()
    .describe("Class, role, playbook, archetype — whatever the game calls it. Free text because games vary."),
  tags: z
    .array(z.string())
    .max(15)
    .optional()
    .describe("Short descriptors: style, attitude, reputation. Up to 15."),
  permanent_traits: z
    .array(z.string())
    .max(20)
    .optional()
    .describe("Scars, advancements, gained abilities, long-term conditions. Up to 20. Replaces wholesale on upsert."),
  bonds: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Relationships, loyalties, rivalries the PC holds. Up to 10."),
  notes: notesField,
} as const;

export function createGMMemoryTools(stateDir: string) {
  return [
    createScratchpadTool(stateDir),

    createTypedBookTool({
      name: "npcs",
      filename: "npcs.json",
      stateDir,
      recordShape: npcsShape,
      description:
        "Named-NPC dossier. Use when the player meets, names, or changes their relationship to a specific named person — e.g. the dockmaster Elin greets the PC, the bartender reveals a secret, an NPC dies. Operations: list (roster), get (full dossier), upsert (create or merge changed fields — arrays replace wholesale), remove. Names are case-sensitive. Do NOT use for: unnamed background characters, the PC(s) (use character_sheets), groups or organisations (use factions).",
    }),

    createTypedBookTool({
      name: "factions",
      filename: "factions.json",
      stateDir,
      recordShape: factionsShape,
      description:
        "Faction dossier — organisations, governments, cults, guilds, criminal crews, military units. Use when a collective actor appears or shifts stance: the PC offends the Harbour Guild, a cult gains a new goal, a government changes its disposition. Operations: list / get / upsert / remove. Upsert with only changed fields; arrays replace wholesale. Do NOT use for: individual named NPCs (use npcs), unnamed crowds, party-level dynamics (use scratchpad).",
    }),

    createTypedBookTool({
      name: "character_sheets",
      filename: "character-sheets.json",
      stateDir,
      recordShape: characterSheetsShape,
      description:
        "Player-character dossier — name, concept, playbook, pronouns, permanent traits, bonds. Use during character creation, after advancement, when a scar or permanent condition is gained, when the player revises their character. Operations: list / get / upsert / remove. Do NOT use for: live mechanical counters like current HP or stress (use the game's resource tool), session notes or plot threads (use scratchpad), other named characters (use npcs).",
    }),
  ];
}
