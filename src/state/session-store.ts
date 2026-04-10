import type { ResourceState, ClockState, DeckState } from "../types/index.js";

/**
 * In-memory state store for a single game session.
 * Holds resources, clocks, and decks across tool calls.
 *
 * Created once per MCP server instance and injected into tool wrappers via closure.
 */
export class SessionStore {
  private resources = new Map<string, Map<string, ResourceState>>();
  private clocks = new Map<string, ClockState>();
  private decks = new Map<string, DeckState>();

  // ── Resources ──

  getResource(entity: string, resource: string): ResourceState | undefined {
    return this.resources.get(entity)?.get(resource);
  }

  setResource(entity: string, resource: string, state: ResourceState): void {
    if (!this.resources.has(entity)) {
      this.resources.set(entity, new Map());
    }
    this.resources.get(entity)!.set(resource, state);
  }

  listResources(entity: string): Map<string, ResourceState> {
    return this.resources.get(entity) ?? new Map();
  }

  listEntities(): string[] {
    return [...this.resources.keys()];
  }

  // ── Clocks ──

  getClock(name: string): ClockState | undefined {
    return this.clocks.get(name);
  }

  setClock(name: string, state: ClockState): void {
    this.clocks.set(name, state);
  }

  deleteClock(name: string): boolean {
    return this.clocks.delete(name);
  }

  listClocks(): ClockState[] {
    return [...this.clocks.values()];
  }

  // ── Decks ──

  getDeck(name: string): DeckState | undefined {
    return this.decks.get(name);
  }

  createDeck(name: string, items: string[]): DeckState {
    const deck: DeckState = {
      name,
      originalItems: [...items],
      remaining: [...items],
    };
    this.decks.set(name, deck);
    return deck;
  }

  updateDeckRemaining(name: string, remaining: string[]): void {
    const deck = this.decks.get(name);
    if (!deck) {
      throw new Error(`Deck not found: "${name}"`);
    }
    deck.remaining = remaining;
  }

  resetDeck(name: string): DeckState | undefined {
    const deck = this.decks.get(name);
    if (!deck) return undefined;
    deck.remaining = [...deck.originalItems];
    return deck;
  }

  deleteDeck(name: string): boolean {
    return this.decks.delete(name);
  }

  listDecks(): DeckState[] {
    return [...this.decks.values()];
  }
}
