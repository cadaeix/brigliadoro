import { describe, it, expect } from "vitest";
import { createClock, advanceClock, reduceClock } from "../../src/primitives/clock.js";

describe("createClock", () => {
  it("creates a clock with 0 filled segments", () => {
    const clock = createClock("Doom", 6);
    expect(clock).toEqual({ name: "Doom", segments: 6, filled: 0, complete: false });
  });

  it("rejects 0 segments", () => {
    expect(() => createClock("Bad", 0)).toThrow("at least 1 segment");
  });
});

describe("advanceClock", () => {
  it("advances by 1 segment by default", () => {
    const clock = createClock("Doom", 6);
    const result = advanceClock(clock);
    expect(result.clock.filled).toBe(1);
    expect(result.previousFilled).toBe(0);
    expect(result.justCompleted).toBe(false);
  });

  it("advances by multiple segments", () => {
    const clock = createClock("Doom", 4);
    const result = advanceClock(clock, 3);
    expect(result.clock.filled).toBe(3);
  });

  it("completes the clock", () => {
    const clock = { name: "Doom", segments: 4, filled: 3, complete: false };
    const result = advanceClock(clock);
    expect(result.clock.filled).toBe(4);
    expect(result.clock.complete).toBe(true);
    expect(result.justCompleted).toBe(true);
  });

  it("caps at max segments", () => {
    const clock = { name: "Doom", segments: 4, filled: 3, complete: false };
    const result = advanceClock(clock, 5);
    expect(result.clock.filled).toBe(4);
  });

  it("justCompleted is false if already complete", () => {
    const clock = { name: "Doom", segments: 4, filled: 4, complete: true };
    const result = advanceClock(clock, 1);
    expect(result.justCompleted).toBe(false);
  });
});

describe("reduceClock", () => {
  it("reduces by 1 segment by default", () => {
    const clock = { name: "Doom", segments: 6, filled: 3, complete: false };
    const result = reduceClock(clock);
    expect(result.clock.filled).toBe(2);
    expect(result.previousFilled).toBe(3);
  });

  it("cannot go below 0", () => {
    const clock = { name: "Doom", segments: 6, filled: 1, complete: false };
    const result = reduceClock(clock, 5);
    expect(result.clock.filled).toBe(0);
  });

  it("un-completes a clock", () => {
    const clock = { name: "Doom", segments: 4, filled: 4, complete: true };
    const result = reduceClock(clock, 1);
    expect(result.clock.complete).toBe(false);
    expect(result.clock.filled).toBe(3);
  });
});
