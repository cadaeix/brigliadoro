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
