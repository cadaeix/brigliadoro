import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createClock,
  advanceClock,
  reduceClock,
} from "../primitives/clock.js";
import type { SessionStore } from "../state/session-store.js";

export function createClockTool(store: SessionStore) {
  return tool(
    "clock",
    'Manage progress clocks. Use for countdowns, tension, long-term projects, faction goals, etc. Operations: "create" a new clock with N segments, "advance" to fill segments, "reduce" to unfill, "check" to view current state, "list" to see all clocks, "delete" to remove.',
    {
      operation: z.enum(["create", "advance", "reduce", "check", "list", "delete"]),
      name: z
        .string()
        .optional()
        .describe('Clock name (required for all operations except "list")'),
      segments: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of segments: total for create, amount to advance/reduce (default 1)"),
    },
    async ({ operation, name, segments }) => {
      try {
        if (operation === "list") {
          const clocks = store.listClocks();
          if (clocks.length === 0) {
            return { content: [{ type: "text" as const, text: "No active clocks." }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(clocks) }] };
        }

        if (!name) {
          return {
            content: [{ type: "text" as const, text: `Clock name is required for "${operation}"` }],
            isError: true,
          };
        }

        if (operation === "create") {
          if (!segments) {
            return {
              content: [{ type: "text" as const, text: "Segments count is required for create" }],
              isError: true,
            };
          }
          const clock = createClock(name, segments);
          store.setClock(name, clock);
          return { content: [{ type: "text" as const, text: JSON.stringify(clock) }] };
        }

        if (operation === "delete") {
          const deleted = store.deleteClock(name);
          if (!deleted) {
            return {
              content: [{ type: "text" as const, text: `Clock "${name}" not found` }],
              isError: true,
            };
          }
          return { content: [{ type: "text" as const, text: `Clock "${name}" deleted` }] };
        }

        // advance, reduce, check
        const existing = store.getClock(name);
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Clock "${name}" not found. Create it first.` }],
            isError: true,
          };
        }

        if (operation === "check") {
          return { content: [{ type: "text" as const, text: JSON.stringify(existing) }] };
        }

        const result =
          operation === "advance"
            ? advanceClock(existing, segments ?? 1)
            : reduceClock(existing, segments ?? 1);

        store.setClock(name, result.clock);
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
