import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { setResource, modifyResource } from "../primitives/resource.js";
import type { SessionStore } from "../state/session-store.js";

export function createResourceTool(store: SessionStore) {
  return tool(
    "track_resource",
    'Track a named numeric resource for an entity (character, party, faction, etc.). Use operation "set" to create or overwrite, "add" to increase, "subtract" to decrease. Values are clamped to min/max bounds if set. Examples: set HP to 20 with max 20, subtract 5 gold, add 1 stress.',
    {
      entity: z.string().describe('Entity name, e.g. "Valeria", "Party", "The Vanguard"'),
      resource: z.string().describe('Resource name, e.g. "HP", "gold", "stress"'),
      operation: z.enum(["set", "add", "subtract"]),
      value: z.number().describe("Value to set/add/subtract"),
      min: z.number().optional().describe("Minimum bound (set operation only, persists)"),
      max: z.number().optional().describe("Maximum bound (set operation only, persists)"),
    },
    async ({ entity, resource, operation, value, min, max }) => {
      try {
        const current = store.getResource(entity, resource);

        let result;
        if (operation === "set") {
          result = setResource(entity, resource, value, current, { min, max });
          store.setResource(entity, resource, {
            value: result.newValue,
            min: min ?? current?.min,
            max: max ?? current?.max,
          });
        } else {
          if (!current) {
            return {
              content: [{ type: "text" as const, text: `Resource "${resource}" not found on "${entity}". Use "set" to create it first.` }],
              isError: true,
            };
          }
          const delta = operation === "add" ? value : -value;
          result = modifyResource(entity, resource, delta, current);
          store.setResource(entity, resource, {
            value: result.newValue,
            min: current.min,
            max: current.max,
          });
        }

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
