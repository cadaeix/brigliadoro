// Pure functions — for direct use by generated game tools
export {
  parseDiceNotation,
  rollDice,
  drawFromPool,
  weightedPick,
  shuffle,
  coinFlip,
  setResource,
  modifyResource,
  createClock,
  advanceClock,
  reduceClock,
  rollOnTable,
} from "./primitives/index.js";

// Types
export type {
  ParsedDice,
  DiceRollResult,
  DrawResult,
  WeightedPickResult,
  ResourceState,
  ResourceOpResult,
  ClockState,
  ClockOpResult,
  DeckState,
  Table,
  TableEntry,
  TableRollResult,
  TableRollChainStep,
} from "./types/index.js";

// MCP server
export { createBrigliadoroServer } from "./tools/index.js";

// State
export { SessionStore } from "./state/session-store.js";
export { InMemoryStepStore } from "./state/step-store.js";
export type { StepStore } from "./state/step-store.js";

// Runner utilities
export { buildFacilitatorSystemPrompt } from "./runner/facilitator-prompt-template.js";
export type { FacilitatorPromptConfig } from "./runner/facilitator-prompt-template.js";
export { createScratchpadTool } from "./runner/scratchpad-tool.js";
export { createTypedBookTool } from "./runner/typed-book-tool.js";
export type { TypedBookOptions } from "./runner/typed-book-tool.js";
export { createFacilitatorMemoryTools } from "./runner/facilitator-memory.js";

// Test helpers (deterministic RNGs for differential testing)
export { seededRng, sequenceRng } from "./test-helpers/index.js";

// Shared hint vocabulary (Pressure, SuggestedBeat)
export type { Pressure, SuggestedBeat } from "./hints/index.js";
export { PRESSURE_VALUES, SUGGESTED_BEAT_VALUES } from "./hints/index.js";
