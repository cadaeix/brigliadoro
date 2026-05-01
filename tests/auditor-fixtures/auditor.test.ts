/**
 * Unit-test suite for the coherence auditor.
 *
 * Each test runs the auditor against a hand-crafted fixture under
 * `tests/auditor-fixtures/<name>/` and asserts the auditor's structured
 * report contains (or doesn't contain) specific findings.
 *
 * The suite is invoked by `npm run test:auditor`, NOT by the default
 * `npm test`. It's slow (Haiku tool calls, ~30s-2min per fixture) and
 * mildly nondeterministic (LLM classification), so it's decoupled from
 * automated git workflows. Run it manually after auditor prompt or
 * schema changes.
 *
 * Assertions deliberately err toward category + severity rather than
 * specific `kind` strings or detail substrings — the schema makes those
 * fields free-form because Haiku's natural labels vary, so anchoring on
 * exact strings produces flaky tests.
 */

import { describe, expect, it } from "vitest";
import { auditFixture } from "./_helpers/fixture.js";

// 5-minute per-test timeout — fixtures invoke a real Haiku agent that
// reads the manifest, greps the source, and assembles a structured report.
const PER_TEST_TIMEOUT_MS = 5 * 60 * 1000;

describe("coherence auditor — fixture suite", () => {
  it(
    "clean fixture: every claim verifies, no blockers, no warnings",
    async () => {
      const report = await auditFixture("clean");

      expect(report.runner_name).toBeTruthy();
      expect(report.overall_severity).toBe("ok");

      // Every manifest tool produces a per-tool grounding result.
      expect(report.source_grounding.per_tool.length).toBeGreaterThanOrEqual(2);

      // No tool's quote is fiction / flavour / commentary.
      for (const tool of report.source_grounding.per_tool) {
        expect(tool.quote_kind).toBe("rules");
        expect(tool.severity).not.toBe("blocker");
      }

      // No duplicate-quote findings on a clean manifest.
      expect(report.source_grounding.duplicate_quotes).toHaveLength(0);

      // Manifest consistency clean.
      const manifestBlockers = report.manifest_consistency.issues.filter(
        (i) => i.severity === "blocker"
      );
      expect(manifestBlockers).toHaveLength(0);

      // Facilitator coherence clean.
      const coherenceBlockers = report.facilitator_coherence.issues.filter(
        (i) => i.severity === "blocker"
      );
      expect(coherenceBlockers).toHaveLength(0);
    },
    PER_TEST_TIMEOUT_MS
  );
});
