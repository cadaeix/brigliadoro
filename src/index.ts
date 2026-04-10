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
} from "./types/index.js";

// MCP server
export { createBrigliadoroServer } from "./tools/index.js";

// State
export { SessionStore } from "./state/session-store.js";
