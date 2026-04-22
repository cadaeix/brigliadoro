import { describe, it, expect, afterEach } from "vitest";
import {
  installSeededRng,
  installSequenceRng,
  parseSequenceArg,
} from "../../src/runner/seeded-rng.js";
import { seededRng } from "../../src/test-helpers/index.js";

describe("installSeededRng", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("replaces Math.random with a deterministic stream and restores it", () => {
    const originalRandom = Math.random;
    restore = installSeededRng(42);
    expect(Math.random).not.toBe(originalRandom);

    const expected = seededRng(42);
    for (let i = 0; i < 10; i++) {
      expect(Math.random()).toBe(expected());
    }

    restore();
    restore = null;
    expect(Math.random).toBe(originalRandom);
  });

  it("two installs with the same seed produce the same sequence", () => {
    restore = installSeededRng(7);
    const streamA = Array.from({ length: 8 }, () => Math.random());
    restore();

    restore = installSeededRng(7);
    const streamB = Array.from({ length: 8 }, () => Math.random());
    restore();
    restore = null;

    expect(streamA).toEqual(streamB);
  });

  it("different seeds produce different streams", () => {
    restore = installSeededRng(1);
    const streamA = Array.from({ length: 8 }, () => Math.random());
    restore();

    restore = installSeededRng(2);
    const streamB = Array.from({ length: 8 }, () => Math.random());
    restore();
    restore = null;

    expect(streamA).not.toEqual(streamB);
  });
});

describe("installSequenceRng", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("cycles through the given values", () => {
    restore = installSequenceRng([0.1, 0.5, 0.9]);
    expect(Math.random()).toBe(0.1);
    expect(Math.random()).toBe(0.5);
    expect(Math.random()).toBe(0.9);
    expect(Math.random()).toBe(0.1);
    expect(Math.random()).toBe(0.5);
  });
});

describe("parseSequenceArg", () => {
  it("parses a comma-separated list of values in [0, 1)", () => {
    expect(parseSequenceArg("0.1,0.5,0.9")).toEqual([0.1, 0.5, 0.9]);
  });

  it("trims whitespace and ignores empty entries", () => {
    expect(parseSequenceArg(" 0.1 , 0.5 ,  , 0.9 ")).toEqual([0.1, 0.5, 0.9]);
  });

  it("rejects non-numeric entries", () => {
    expect(() => parseSequenceArg("0.1,banana,0.5")).toThrow(
      /not a finite number/
    );
  });

  it("rejects out-of-range entries", () => {
    expect(() => parseSequenceArg("0.1,1.0")).toThrow(/must be in \[0, 1\)/);
    expect(() => parseSequenceArg("-0.1,0.5")).toThrow(/must be in \[0, 1\)/);
  });

  it("rejects empty input", () => {
    expect(() => parseSequenceArg("")).toThrow(/at least one value/);
    expect(() => parseSequenceArg(" , , ")).toThrow(/at least one value/);
  });
});
