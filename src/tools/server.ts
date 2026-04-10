import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "../state/session-store.js";
import { createDiceRollTool } from "./dice-tool.js";
import { createDrawTool, createWeightedPickTool, createCoinFlipTool } from "./random-tool.js";
import { createResourceTool } from "./resource-tool.js";
import { createClockTool } from "./clock-tool.js";

/**
 * Create the Brigliadoro MCP server with all foundation tools.
 *
 * Tool names when registered:
 *   mcp__brigliadoro__roll_dice
 *   mcp__brigliadoro__draw_random
 *   mcp__brigliadoro__weighted_pick
 *   mcp__brigliadoro__coin_flip
 *   mcp__brigliadoro__track_resource
 *   mcp__brigliadoro__clock
 */
export function createBrigliadoroServer() {
  const store = new SessionStore();

  return createSdkMcpServer({
    name: "brigliadoro",
    version: "0.1.0",
    tools: [
      createDiceRollTool(),
      createDrawTool(store),
      createWeightedPickTool(),
      createCoinFlipTool(),
      createResourceTool(store),
      createClockTool(store),
    ],
  });
}
