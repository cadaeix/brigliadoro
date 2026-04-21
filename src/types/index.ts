// ── Dice ──

export interface ParsedDice {
  count: number;
  sides: number | "F"; // "F" for Fate/Fudge dice (-1, 0, +1)
  modifier: number;
  keep?: { type: "highest" | "lowest"; count: number };
  exploding: boolean;
}

export interface DiceRollResult {
  notation: string;
  rolls: number[];
  kept: number[];
  modifier: number;
  total: number;
  details: string; // human-readable: "[3, 5, 1] kh2 → [5, 3] + 2 = 10"
}

// ── Randomness ──

export interface DrawResult {
  drawn: string[];
  remaining: number;
  replacement: boolean;
}

export interface WeightedPickResult {
  picked: string;
  weight: number;
  roll: number;
}

// ── Resources ──

export interface ResourceState {
  value: number;
  min?: number;
  max?: number;
}

export interface ResourceOpResult {
  entity: string;
  resource: string;
  previousValue: number;
  newValue: number;
  clampedAtMin: boolean;
  clampedAtMax: boolean;
}

// ── Clocks ──

export interface ClockState {
  name: string;
  segments: number;
  filled: number;
  complete: boolean;
}

export interface ClockOpResult {
  clock: ClockState;
  previousFilled: number;
  justCompleted: boolean;
}

// ── Session Store ──

export interface DeckState {
  name: string;
  originalItems: string[];
  remaining: string[];
}

// ── Random tables ──

export interface TableEntry<T = string> {
  /** Inclusive die-roll range for this entry. e.g. [1, 5] on a d20 covers rolls 1–5. */
  range: [number, number];
  item: T;
  /** Optional: when this entry matches, reroll onto another table.
   *  Used for nested/layered tables (common in OSR-style random-encounter tables). */
  rerollOnto?: Table<T>;
}

export interface Table<T = string> {
  /** Human-friendly table name for logging and TableRollResult.table. Optional. */
  name?: string;
  /** Dice notation driving the roll, e.g. "1d6", "2d6", "1d100". Modifiers allowed. */
  notation: string;
  /** Entries with inclusive ranges. First-match-wins if they overlap. */
  entries: TableEntry<T>[];
}

export interface TableRollChainStep<T = string> {
  table: string;
  notation: string;
  roll: number;
  item: T;
}

export interface TableRollResult<T = string> {
  /** Name of the first (outer) table rolled. */
  table: string;
  notation: string;
  /** The raw roll total on the outer table. */
  roll: number;
  /** The leaf item — if the chain has rerolls, this is the final entry. */
  item: T;
  /** Every step of the roll chain. Always at least one entry. Nested rerolls append. */
  chain: TableRollChainStep<T>[];
}
