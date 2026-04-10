import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "runners/**/tests/**/*.test.ts"],
  },
});
