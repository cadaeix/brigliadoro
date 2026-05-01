// Fixture file — read by the auditor as text, not compiled or executed.
// Mirrors the shape of a real runner's server.ts so the auditor's
// "wired tools" check has something to parse.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createSendMessage } from "./send-message.js";
import { createRollComplication } from "./roll-complication.js";
import { createSealLetter } from "./seal-letter.js";

export function createGameServer() {
  return createSdkMcpServer({
    name: "the-cipher",
    version: "1.0.0",
    tools: [
      createSendMessage(),
      createRollComplication(),
      createSealLetter(),
    ],
  });
}
