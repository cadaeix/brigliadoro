import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "runners/**/tests/**/*.test.ts"],
    // - Auditor fixture suite runs on its own slow LLM config
    //   (vitest.auditor.config.ts via `npm run test:auditor`).
    // - `**/node_modules/**` — the runners/<name>/tests/**/*.test.ts
    //   include pattern would otherwise match the zod library's internal
    //   tests inside runners/<name>/node_modules/zod/.../tests/.
    // - `runners/_archive/**` — old runners moved aside at regen time;
    //   their tests aren't current and their node_modules are stale.
    exclude: [
      "tests/auditor-fixtures/**",
      "**/node_modules/**",
      "dist/**",
      "runners/_archive/**",
    ],
  },
});
