// Fixture file — read by the auditor as text.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createSendMessage } from "./send-message.js";
import { createCheckCipher } from "./check-cipher.js";

export function createGameServer() {
  return createSdkMcpServer({
    name: "the-cipher",
    version: "1.0.0",
    tools: [createSendMessage(), createCheckCipher()],
  });
}
