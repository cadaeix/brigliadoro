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

  it(
    "fiction-quote fixture: send_message's quote points at the play-example",
    async () => {
      const report = await auditFixture("fiction-quote");
      expect(report.overall_severity).toBe("has_blockers");

      const culprit = report.source_grounding.per_tool.find(
        (t) => t.tool_name === "send_message"
      );
      expect(culprit, "expected a per_tool entry for send_message").toBeDefined();
      expect(culprit!.quote_kind).toBe("fiction");
      expect(culprit!.severity).toBe("blocker");
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "duplicate-quote fixture: two tools cite the same passage",
    async () => {
      const report = await auditFixture("duplicate-quote");

      // The auditor must surface the duplicate. Severity can land on
      // blocker or warning depending on how Haiku reads the summaries —
      // the prompt allows downgrading to warning when the two tool
      // summaries describe genuinely different aspects of the passage.
      // What we always require: the finding exists, the severity isn't
      // silent, and both tools are named.
      expect(report.overall_severity).not.toBe("ok");
      expect(report.source_grounding.duplicate_quotes.length).toBeGreaterThanOrEqual(1);

      const dup = report.source_grounding.duplicate_quotes[0]!;
      expect(dup.tools).toContain("send_message");
      expect(dup.tools).toContain("check_cipher");
      expect(["warning", "blocker"]).toContain(dup.severity);
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "tier-mismatch fixture: prompt narrates wrong tier names",
    async () => {
      const report = await auditFixture("tier-mismatch");
      expect(report.overall_severity).toBe("has_blockers");

      // A facilitator-coherence blocker should land for send_message
      // (manifest declares clear/garbled/lost; prompt narrates success/partial/failure).
      const blocker = report.facilitator_coherence.issues.find(
        (i) => i.severity === "blocker"
      );
      expect(blocker, "expected a facilitator-coherence blocker").toBeDefined();
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "uncovered-flag fixture: cipher_broken declared in manifest but not narrated",
    async () => {
      const report = await auditFixture("uncovered-flag");

      // Severity is warning-or-blocker (auditor's call); the issue must surface.
      expect(report.overall_severity).not.toBe("ok");

      const flagIssue = report.facilitator_coherence.issues.find((i) =>
        /cipher_broken|flag/i.test(i.detail) ||
        (i.kind && /flag|coverage/i.test(i.kind))
      );
      expect(
        flagIssue,
        "expected an uncovered-flag finding mentioning cipher_broken"
      ).toBeDefined();
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "orphan-tool fixture: server.ts wires a tool not in the manifest",
    async () => {
      const report = await auditFixture("orphan-tool");
      expect(report.overall_severity).toBe("has_blockers");

      // The wired-but-unmanifested tool should surface in manifest_consistency.
      const orphanIssue = report.manifest_consistency.issues.find((i) =>
        /seal_letter|seal-letter/i.test(i.detail)
      );
      expect(
        orphanIssue,
        "expected a manifest-consistency issue mentioning seal_letter"
      ).toBeDefined();
      expect(orphanIssue!.severity).toBe("blocker");
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "empty-quote-invented fixture: a tool with empty source_ref.quote and no structural carve-out",
    async () => {
      const report = await auditFixture("empty-quote-invented");
      expect(report.overall_severity).toBe("has_blockers");

      const invented = report.source_grounding.per_tool.find(
        (t) => t.tool_name === "track_emotional_distance"
      );
      expect(invented, "expected per_tool entry for track_emotional_distance").toBeDefined();
      expect(invented!.quote_status).toBe("empty");
      expect(invented!.severity).toBe("blocker");
    },
    PER_TEST_TIMEOUT_MS
  );
});
