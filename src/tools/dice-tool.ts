import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { rollDice } from "../primitives/dice.js";

export function createDiceRollTool() {
  return tool(
    "roll_dice",
    'Roll dice using standard notation. Examples: "2d6" (two six-sided dice), "1d20+5" (d20 with +5 modifier), "4d6kh3" (roll 4d6, keep highest 3), "2d20kl1" (disadvantage), "1d6!" (exploding d6), "d%" (percentile 1-100), "2dF" (two Fate dice). Returns individual rolls, kept rolls, modifier, and total.',
    { notation: z.string().describe('Dice notation, e.g. "2d6+1", "4d6kh3", "d%"') },
    async ({ notation }) => {
      try {
        const result = rollDice(notation);
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
