// Fixture file — read by the auditor as text, not compiled or executed.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createSendMessage } from "./send-message.js";
import { createRollComplication } from "./roll-complication.js";

export function createGameServer() {
  return createSdkMcpServer({
    name: "the-cipher",
    version: "1.0.0",
    tools: [createSendMessage(), createRollComplication()],
  });
}
