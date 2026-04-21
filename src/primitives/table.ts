/**
 * Random-table primitive.
 *
 * Conceptually distinct from `drawFromPool` / `weightedPick`: a TTRPG random
 * table is a **ranged-entry die roll** — you roll a specific die (1d6, 1d20,
 * 1d100) and look up which entry's range the result falls into. Entries can
 * cover ranges of unequal size ("1-5: rare event; 6-15: common; 16-20: special")
 * and can recursively reroll onto a subtable.
 *
 * Mechanically this could be simulated with drawFromPool + duplicated entries,
 * but that loses the "this is a table roll with a specific die" framing. Tools
 * that wrap random tables in a sourcebook should call `rollOnTable` so the
 * intent is legible at the call site.
 *
 * Determinism: takes an optional `rng` for seeded tests, threaded through to
 * the underlying `rollDice` call.
 */
import { rollDice } from "./dice.js";
import type {
  Table,
  TableEntry,
  TableRollResult,
  TableRollChainStep,
} from "../types/index.js";

/** Cap on nested rerolls to catch circular `rerollOnto` references. */
const MAX_REROLL_DEPTH = 10;

/**
 * Roll on a table, following `rerollOnto` chains up to MAX_REROLL_DEPTH.
 * Returns the leaf item plus the full chain of rolls.
 *
 * Throws if:
 * - A roll result doesn't fall into any entry's range (gap in the table)
 * - The reroll chain exceeds MAX_REROLL_DEPTH (circular reference)
 */
export function rollOnTable<T>(
  table: Table<T>,
  rng: () => number = Math.random
): TableRollResult<T> {
  const chain: TableRollChainStep<T>[] = [];
  let current: Table<T> = table;
  let depth = 0;
  let leafItem: T | undefined;

  while (true) {
    if (depth > MAX_REROLL_DEPTH) {
      throw new Error(
        `rollOnTable: reroll chain exceeded ${MAX_REROLL_DEPTH} on "${current.name ?? current.notation}". Check for circular rerollOnto references.`
      );
    }
    const rolled = rollDice(current.notation, rng);
    const tableLabel = current.name ?? current.notation;
    const entry = findEntry(current.entries, rolled.total);
    if (!entry) {
      const ranges = current.entries
        .map((e) => `[${e.range[0]}-${e.range[1]}]`)
        .join(", ");
      throw new Error(
        `rollOnTable: rolled ${rolled.total} on "${tableLabel}" (${current.notation}) but no entry's range matched. Entries: ${ranges}`
      );
    }
    chain.push({
      table: tableLabel,
      notation: current.notation,
      roll: rolled.total,
      item: entry.item,
    });
    if (entry.rerollOnto) {
      current = entry.rerollOnto;
      depth++;
      continue;
    }
    leafItem = entry.item;
    break;
  }

  const first = chain[0]!;
  return {
    table: first.table,
    notation: first.notation,
    roll: first.roll,
    item: leafItem!,
    chain,
  };
}

function findEntry<T>(
  entries: TableEntry<T>[],
  roll: number
): TableEntry<T> | undefined {
  for (const e of entries) {
    const [lo, hi] = e.range;
    if (roll >= lo && roll <= hi) return e;
  }
  return undefined;
}
