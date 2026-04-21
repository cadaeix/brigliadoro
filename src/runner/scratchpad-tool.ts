/**
 * Scratchpad MCP tool — persistent notes for the facilitator agent.
 *
 * Operations:
 * - read: Read the entire scratchpad
 * - write: Overwrite the scratchpad with new content
 * - append: Append a section to the scratchpad
 *
 * The scratchpad is stored as a markdown file in the runner's state/ directory.
 * This file is compiled and copied into runners as part of lib/.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

export function createScratchpadTool(stateDir: string) {
  const scratchpadPath = path.join(stateDir, "scratchpad.md");

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  return tool(
    "scratchpad",
    "Read or write your scratchpad — persistent freeform markdown notes for tracking plot threads, session plans, player mood, vibes, and anything else you want to remember across sessions. Use this proactively: write at session start/end, when important things happen, and whenever you'll want to recall something later. Read when you need context about the story so far. For named entities (NPCs, factions, PCs) use the dedicated books instead.",
    {
      operation: z
        .enum(["read", "write", "append"])
        .describe(
          "read: get current scratchpad contents. write: replace entire scratchpad. append: add a new section to the end."
        ),
      content: z
        .string()
        .optional()
        .describe(
          "The content to write or append. Required for write/append operations. Use markdown formatting."
        ),
    },
    async (args) => {
      switch (args.operation) {
        case "read": {
          if (!fs.existsSync(scratchpadPath)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "(Scratchpad is empty. Use write or append to add notes.)",
                },
              ],
            };
          }
          const contents = fs.readFileSync(scratchpadPath, "utf-8");
          return {
            content: [{ type: "text" as const, text: contents }],
          };
        }

        case "write": {
          if (!args.content) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: content is required for write operation.",
                },
              ],
              isError: true,
            };
          }
          fs.writeFileSync(scratchpadPath, args.content, "utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: `Scratchpad updated (${args.content.length} chars).`,
              },
            ],
          };
        }

        case "append": {
          if (!args.content) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: content is required for append operation.",
                },
              ],
              isError: true,
            };
          }
          const existing = fs.existsSync(scratchpadPath)
            ? fs.readFileSync(scratchpadPath, "utf-8")
            : "";
          const separator = existing.length > 0 ? "\n\n---\n\n" : "";
          fs.writeFileSync(
            scratchpadPath,
            existing + separator + args.content,
            "utf-8"
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Appended to scratchpad (${args.content.length} chars added).`,
              },
            ],
          };
        }
      }
    }
  );
}
