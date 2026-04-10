import { describe, it, expect } from "vitest";
import { setResource, modifyResource } from "../../src/primitives/resource.js";

describe("setResource", () => {
  it("creates a new resource", () => {
    const result = setResource("Hero", "HP", 20, undefined, { min: 0, max: 20 });
    expect(result.entity).toBe("Hero");
    expect(result.resource).toBe("HP");
    expect(result.previousValue).toBe(0);
    expect(result.newValue).toBe(20);
  });

  it("clamps to max", () => {
    const result = setResource("Hero", "HP", 25, undefined, { min: 0, max: 20 });
    expect(result.newValue).toBe(20);
    expect(result.clampedAtMax).toBe(true);
  });

  it("clamps to min", () => {
    const result = setResource("Hero", "HP", -5, undefined, { min: 0, max: 20 });
    expect(result.newValue).toBe(0);
    expect(result.clampedAtMin).toBe(true);
  });

  it("overwrites existing resource", () => {
    const current = { value: 15, min: 0, max: 20 };
    const result = setResource("Hero", "HP", 10, current);
    expect(result.previousValue).toBe(15);
    expect(result.newValue).toBe(10);
  });
});

describe("modifyResource", () => {
  it("adds to resource", () => {
    const current = { value: 10, min: 0, max: 20 };
    const result = modifyResource("Hero", "HP", 5, current);
    expect(result.newValue).toBe(15);
    expect(result.clampedAtMax).toBe(false);
  });

  it("subtracts from resource", () => {
    const current = { value: 10, min: 0, max: 20 };
    const result = modifyResource("Hero", "HP", -3, current);
    expect(result.newValue).toBe(7);
  });

  it("clamps at min on subtract", () => {
    const current = { value: 3, min: 0, max: 20 };
    const result = modifyResource("Hero", "HP", -10, current);
    expect(result.newValue).toBe(0);
    expect(result.clampedAtMin).toBe(true);
  });

  it("clamps at max on add", () => {
    const current = { value: 18, min: 0, max: 20 };
    const result = modifyResource("Hero", "HP", 5, current);
    expect(result.newValue).toBe(20);
    expect(result.clampedAtMax).toBe(true);
  });

  it("works without bounds", () => {
    const current = { value: 5 };
    const result = modifyResource("Hero", "gold", 100, current);
    expect(result.newValue).toBe(105);
    expect(result.clampedAtMin).toBe(false);
    expect(result.clampedAtMax).toBe(false);
  });
});
