import type { ClockState, ClockOpResult } from "../types/index.js";

/**
 * Create a new clock with the given number of segments.
 *
 * @param name - Clock name (e.g. "Doom", "Investigation Progress")
 * @param segments - Total segments (typically 4, 6, or 8)
 */
export function createClock(name: string, segments: number): ClockState {
  if (segments < 1) {
    throw new Error(`Clock must have at least 1 segment: ${segments}`);
  }
  return { name, segments, filled: 0, complete: false };
}

/**
 * Advance (fill) segments on a clock. Default: 1 segment.
 * Cannot exceed total segments.
 */
export function advanceClock(
  clock: ClockState,
  segments: number = 1
): ClockOpResult {
  const previousFilled = clock.filled;
  const newFilled = Math.min(clock.filled + segments, clock.segments);
  const complete = newFilled >= clock.segments;

  return {
    clock: { ...clock, filled: newFilled, complete },
    previousFilled,
    justCompleted: complete && !clock.complete,
  };
}

/**
 * Reduce (unfill) segments on a clock. Default: 1 segment.
 * Cannot go below 0.
 */
export function reduceClock(
  clock: ClockState,
  segments: number = 1
): ClockOpResult {
  const previousFilled = clock.filled;
  const newFilled = Math.max(clock.filled - segments, 0);

  return {
    clock: { ...clock, filled: newFilled, complete: false },
    previousFilled,
    justCompleted: false,
  };
}
