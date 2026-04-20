import { describe, it, expect } from "vitest";
import { InMemoryStepStore } from "../../src/state/step-store.js";

describe("InMemoryStepStore", () => {
  it("returns undefined for an unknown id", async () => {
    const store = new InMemoryStepStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  it("round-trips arbitrary state", async () => {
    const store = new InMemoryStepStore();
    interface HandState {
      player: string[];
      dealer: string[];
      turn: number;
    }
    const state: HandState = {
      player: ["AS", "9H"],
      dealer: ["KD"],
      turn: 1,
    };
    await store.put("round-1", state);
    const got = await store.get<HandState>("round-1");
    expect(got).toEqual(state);
  });

  it("overwrites on second put", async () => {
    const store = new InMemoryStepStore();
    await store.put("k", { v: 1 });
    await store.put("k", { v: 2 });
    expect(await store.get<{ v: number }>("k")).toEqual({ v: 2 });
  });

  it("deletes on del", async () => {
    const store = new InMemoryStepStore();
    await store.put("k", { v: 1 });
    await store.del("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("del is a no-op on unknown id", async () => {
    const store = new InMemoryStepStore();
    await expect(store.del("never-existed")).resolves.toBeUndefined();
  });

  it("isolates keys", async () => {
    const store = new InMemoryStepStore();
    await store.put("a", { n: 1 });
    await store.put("b", { n: 2 });
    expect(await store.get<{ n: number }>("a")).toEqual({ n: 1 });
    expect(await store.get<{ n: number }>("b")).toEqual({ n: 2 });
    expect(store.keys().sort()).toEqual(["a", "b"]);
  });

  it("supports the pausable-tool flow end-to-end", async () => {
    // Mini simulation of the state-machine pattern: start stores state,
    // continue reloads and advances, final step deletes.
    interface Counter { n: number }
    const store = new InMemoryStepStore();
    const stepId = "abc";

    // phase: "start"
    await store.put<Counter>(stepId, { n: 0 });

    // phase: "continue" — load, advance, store
    let s = (await store.get<Counter>(stepId))!;
    s = { n: s.n + 1 };
    await store.put(stepId, s);

    // phase: "continue" again
    s = (await store.get<Counter>(stepId))!;
    s = { n: s.n + 1 };

    // final step → delete
    await store.del(stepId);

    expect(s.n).toBe(2);
    expect(await store.get(stepId)).toBeUndefined();
    expect(store.keys()).toEqual([]);
  });
});
