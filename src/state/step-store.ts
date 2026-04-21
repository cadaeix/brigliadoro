/**
 * Keyed state store for pausable (multi-phase) tool calls.
 *
 * Pausable mechanics — blackjack, card draws that ask hit/stand, resolution
 * systems that prompt the player mid-roll — need to remember their in-progress
 * state across the facilitator turns. The flow:
 *
 *   1. Facilitator calls tool with phase: "start"  → tool stores state keyed by stepId,
 *      returns { status: "awaiting_input", stepId, prompt }.
 *   2. Facilitator narrates the situation and asks the player conversationally.
 *   3. Player responds on their next turn.
 *   4. Facilitator calls tool with phase: "continue", stepId, action → tool reloads
 *      state, advances, either stores again (awaiting_input) or deletes
 *      and returns { status: "done", output }.
 *
 * StepStore is the shape that makes this work. Implementations can be
 * in-memory (default, dies on play.ts restart) or file-backed (survives).
 * The tool code never cares which; it just calls get/put/del.
 */

export interface StepStore {
  /** Return the stored state for a stepId, or undefined if nothing is stored. */
  get<S>(id: string): Promise<S | undefined>;
  /** Overwrite or create the state for a stepId. */
  put<S>(id: string, state: S): Promise<void>;
  /** Delete the state for a stepId. No-op if it doesn't exist. */
  del(id: string): Promise<void>;
}

/**
 * In-memory StepStore. State lives for the lifetime of the process.
 * If play.ts restarts mid-mechanic, in-progress state is lost — the facilitator
 * should recognise this (the tool will report no stored state for the
 * stepId) and restart the mechanic with phase: "start".
 */
export class InMemoryStepStore implements StepStore {
  private map = new Map<string, unknown>();

  async get<S>(id: string): Promise<S | undefined> {
    return this.map.get(id) as S | undefined;
  }

  async put<S>(id: string, state: S): Promise<void> {
    this.map.set(id, state);
  }

  async del(id: string): Promise<void> {
    this.map.delete(id);
  }

  /** Non-interface helper: inspect currently-stored step ids. Useful for tests/debugging. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}
