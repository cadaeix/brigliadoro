import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../../src/state/session-store.js";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe("resources", () => {
    it("returns undefined for nonexistent resource", () => {
      expect(store.getResource("Hero", "HP")).toBeUndefined();
    });

    it("stores and retrieves a resource", () => {
      store.setResource("Hero", "HP", { value: 20, min: 0, max: 20 });
      expect(store.getResource("Hero", "HP")).toEqual({ value: 20, min: 0, max: 20 });
    });

    it("isolates entities", () => {
      store.setResource("Hero", "HP", { value: 20 });
      store.setResource("Villain", "HP", { value: 50 });
      expect(store.getResource("Hero", "HP")?.value).toBe(20);
      expect(store.getResource("Villain", "HP")?.value).toBe(50);
    });

    it("lists resources for an entity", () => {
      store.setResource("Hero", "HP", { value: 20 });
      store.setResource("Hero", "gold", { value: 100 });
      const resources = store.listResources("Hero");
      expect(resources.size).toBe(2);
    });

    it("lists entities", () => {
      store.setResource("Hero", "HP", { value: 20 });
      store.setResource("Villain", "HP", { value: 50 });
      expect(store.listEntities()).toEqual(["Hero", "Villain"]);
    });
  });

  describe("clocks", () => {
    it("returns undefined for nonexistent clock", () => {
      expect(store.getClock("Doom")).toBeUndefined();
    });

    it("stores and retrieves a clock", () => {
      const clock = { name: "Doom", segments: 6, filled: 0, complete: false };
      store.setClock("Doom", clock);
      expect(store.getClock("Doom")).toEqual(clock);
    });

    it("deletes a clock", () => {
      store.setClock("Doom", { name: "Doom", segments: 6, filled: 0, complete: false });
      expect(store.deleteClock("Doom")).toBe(true);
      expect(store.getClock("Doom")).toBeUndefined();
    });

    it("lists all clocks", () => {
      store.setClock("A", { name: "A", segments: 4, filled: 0, complete: false });
      store.setClock("B", { name: "B", segments: 8, filled: 3, complete: false });
      expect(store.listClocks()).toHaveLength(2);
    });
  });

  describe("decks", () => {
    it("creates and retrieves a deck", () => {
      const deck = store.createDeck("tarot", ["Fool", "Magician", "High Priestess"]);
      expect(deck.name).toBe("tarot");
      expect(deck.originalItems).toEqual(["Fool", "Magician", "High Priestess"]);
      expect(deck.remaining).toEqual(["Fool", "Magician", "High Priestess"]);
      expect(store.getDeck("tarot")).toBe(deck);
    });

    it("updates remaining cards", () => {
      store.createDeck("tarot", ["Fool", "Magician", "High Priestess"]);
      store.updateDeckRemaining("tarot", ["Magician"]);
      expect(store.getDeck("tarot")!.remaining).toEqual(["Magician"]);
    });

    it("resets a deck", () => {
      store.createDeck("tarot", ["Fool", "Magician"]);
      store.updateDeckRemaining("tarot", []);
      const reset = store.resetDeck("tarot");
      expect(reset!.remaining).toEqual(["Fool", "Magician"]);
    });

    it("throws on updating nonexistent deck", () => {
      expect(() => store.updateDeckRemaining("nope", [])).toThrow("not found");
    });

    it("deletes a deck", () => {
      store.createDeck("tarot", ["Fool"]);
      expect(store.deleteDeck("tarot")).toBe(true);
      expect(store.getDeck("tarot")).toBeUndefined();
    });
  });
});
