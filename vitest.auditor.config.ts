/**
 * Dedicated vitest config for the coherence-auditor fixture suite.
 *
 * Decoupled from the default `npm test` because:
 *   - Each fixture invokes a real Haiku LLM agent (~30s-2min per test)
 *   - Full suite is ~5-15 min, far past the default test budget
 *   - LLM classification is mildly nondeterministic — flaky in pre-commit
 *     hooks but acceptable as a manually-invoked regression check
 *
 * Invoked via `npm run test:auditor`. The default vitest config
 * (`vitest.config.ts`) excludes the same path so it stays fast.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/auditor-fixtures/**/*.test.ts"],
    // Run sequentially — Haiku tool calls don't usefully parallelise
    // through the SDK and parallel agent invocations risk hitting
    // subscription rate limits unnecessarily.
    fileParallelism: false,
    sequence: { concurrent: false },
    // Per-test timeout big enough for the slowest fixture.
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
