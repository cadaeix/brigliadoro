import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { drawFromPool, weightedPick, shuffle, coinFlip } from "../primitives/random.js";
import type { SessionStore } from "../state/session-store.js";

export function createDrawTool(store: SessionStore) {
  return tool(
    "draw_random",
    'Draw items from a named pool/deck. On first use with a deck name, provide the "items" array to create the deck. Subsequent draws from the same deck continue where the last draw left off (without replacement). Use replacement=true to draw with replacement. Use operation="reset" to reshuffle all items back into the deck, operation="shuffle" to shuffle remaining items.',
    {
      deck: z.string().describe("Name of the deck/pool"),
      operation: z
        .enum(["draw", "reset", "shuffle"])
        .default("draw")
        .describe("Operation to perform"),
      count: z.number().int().min(1).default(1).describe("Number of items to draw"),
      items: z
        .array(z.string())
        .optional()
        .describe("Items in the deck (required on first draw if deck doesn't exist)"),
      replacement: z
        .boolean()
        .default(false)
        .describe("If true, drawn items are returned to the pool"),
    },
    async ({ deck: deckName, operation, count, items, replacement }) => {
      try {
        if (operation === "reset") {
          const reset = store.resetDeck(deckName);
          if (!reset) {
            return {
              content: [{ type: "text" as const, text: `Deck "${deckName}" not found` }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deck: deckName, remaining: reset.remaining.length, message: "Deck reset" }) }],
          };
        }

        if (operation === "shuffle") {
          const existing = store.getDeck(deckName);
          if (!existing) {
            return {
              content: [{ type: "text" as const, text: `Deck "${deckName}" not found` }],
              isError: true,
            };
          }
          const shuffled = shuffle(existing.remaining);
          store.updateDeckRemaining(deckName, shuffled);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ deck: deckName, remaining: shuffled.length, message: "Deck shuffled" }) }],
          };
        }

        // operation === "draw"
        let existing = store.getDeck(deckName);
        if (!existing) {
          if (!items || items.length === 0) {
            return {
              content: [{ type: "text" as const, text: `Deck "${deckName}" does not exist. Provide "items" to create it.` }],
              isError: true,
            };
          }
          existing = store.createDeck(deckName, shuffle(items));
        }

        const pool = replacement ? existing.originalItems : existing.remaining;
        const result = drawFromPool(pool, count, { replacement });

        if (!replacement) {
          // Remove drawn items from remaining
          const remainingAfter = [...existing.remaining];
          for (const drawn of result.drawn) {
            const idx = remainingAfter.indexOf(drawn);
            if (idx !== -1) remainingAfter.splice(idx, 1);
          }
          store.updateDeckRemaining(deckName, remainingAfter);
          result.remaining = remainingAfter.length;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ deck: deckName, ...result }) }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: (e as Error).message }],
          isError: true,
        };
      }
    }
  );
}

export function createWeightedPickTool() {
  return tool(
    "weighted_pick",
    "Pick one item from a weighted list. Higher weight = higher probability of being picked.",
    {
      entries: z
        .array(z.object({ item: z.string(), weight: z.number().positive() }))
        .min(1)
        .describe("Items with their weights"),
    },
    async ({ entries }) => {
      try {
        const result = weightedPick(entries);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: (e as Error).message }],
          isError: true,
        };
      }
    }
  );
}

export function createCoinFlipTool() {
  return tool(
    "coin_flip",
    "Flip a coin. Returns heads or tails.",
    {},
    async () => {
      const result = coinFlip();
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}
