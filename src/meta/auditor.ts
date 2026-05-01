/**
 * Schema for the coherence-auditor subagent's structured report.
 *
 * The auditor is a fresh-context Haiku subagent invoked by the orchestrator
 * after tool-builder + characterizer + validator finish. It verifies three
 * categories of claim, all rooted in the typed `tools/manifest.json`:
 *
 *   1. Source-grounding — does each `source_ref.quote` actually appear in
 *      the source? Is it rules text, or fiction / flavour / commentary?
 *      Are two tools quoting the same passage (a likely split mechanic)?
 *
 *   2. Manifest consistency — every wired tool has a manifest entry; every
 *      manifest entry corresponds to a wired tool; every tool file has a
 *      sibling triggers corpus.
 *
 *   3. Facilitator coherence — the characterizer's `facilitatorPrompt`
 *      references manifest tool names correctly, narrates the manifest's
 *      exact `outcome_tiers` strings, and covers every game-specific flag.
 *
 * The auditor returns this report as JSON in its final response. The
 * orchestrator parses it, decides whether `has_blockers` warrants
 * re-delegation to tool-builder (Job A / manifest housekeeping) or
 * characterizer (Job B), and iterates.
 *
 * Read-only: the auditor never writes files. Fixes always come from the
 * agent that owns the artefact — tool-builder for manifest issues,
 * characterizer for prompt issues.
 *
 * Why this exists as a typed schema:
 * - The orchestrator's re-delegation logic depends on stable issue codes,
 *   so it can route Job A failures to tool-builder and Job B failures to
 *   characterizer mechanically rather than through prose-judging the report.
 * - A future inverse-audit mode (source-against-claims rather than
 *   claims-against-source) extends the same schema with new issue kinds.
 * - The auditor's report becomes provenance: pattern of `not_found`
 *   quote_status across regens is signal for source-format issues
 *   (PDF extraction artefacts, OCR errors) worth investigating.
 */

import { z } from "zod";

/**
 * Whether the manifest entry's `source_ref.quote` was found in the source
 * via grep + context-window read.
 *
 * `not_found` is more often a PDF-extraction issue (curly vs straight
 * quotes, hyphenation across line breaks, OCR errors) than a tool-builder
 * lie. The auditor flags it; the orchestrator surfaces it; the human
 * decides.
 */
export const QuoteStatusSchema = z.enum([
  "verbatim_match",
  "near_match",
  "not_found",
  "empty",
]);
export type QuoteStatus = z.infer<typeof QuoteStatusSchema>;

/**
 * What kind of source text the quote actually is.
 *
 * Mirrors the categories the tool-builder reads in
 * `tool-reference.md#manifest` — keep these aligned. `rules` is the only
 * fully-legitimate kind for a non-empty quote; `structural_carve_out`
 * justifies an empty quote. Everything else is a flag.
 */
export const QuoteKindSchema = z.enum([
  "rules",
  "fiction",
  "flavour",
  "commentary",
  "structural_carve_out",
  "unknown",
]);
export type QuoteKind = z.infer<typeof QuoteKindSchema>;

/**
 * Severity of a single finding.
 *
 * - `ok` — explicit clean entry; lets the report distinguish "verified"
 *   from "absent" per-tool.
 * - `warning` — surface to human, don't trigger re-delegation by default.
 * - `blocker` — orchestrator re-delegates to the responsible subagent.
 */
export const SeveritySchema = z.enum(["ok", "warning", "blocker"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Per-tool source-grounding finding. One entry per manifest tool, even if
 * the entry is clean — gives the orchestrator a complete audit picture
 * rather than only-bad-news.
 */
export const ToolGroundingResultSchema = z.object({
  tool_name: z
    .string()
    .min(1)
    .describe("MCP tool name from the manifest."),
  quote_status: QuoteStatusSchema,
  quote_kind: QuoteKindSchema,
  matched_passage: z
    .string()
    .optional()
    .describe(
      "The source passage that matched, with a few lines of surrounding context. " +
        "Omit for empty / not_found / structural_carve_out cases."
    ),
  source_locator: z
    .string()
    .optional()
    .describe(
      "Where in the source the quote was found — filename, page, section, or line range. " +
        "Format is auditor-defined; meant for human review, not machine parsing."
    ),
  issues: z
    .array(z.string())
    .describe(
      "Plain-language notes from the auditor explaining the classification or any concerns. " +
        "Empty array if everything is fine."
    ),
  severity: SeveritySchema,
});
export type ToolGroundingResult = z.infer<typeof ToolGroundingResultSchema>;

/**
 * Two or more manifest entries citing the same (or substantially
 * overlapping) source passage. Likely indicates one mechanic split into
 * coordinating tools.
 */
export const DuplicateQuoteSchema = z.object({
  quote_substring: z
    .string()
    .describe(
      "The shared distinctive substring across the duplicate quotes. " +
        "Not the full quote — just enough to make the duplication legible."
    ),
  tools: z
    .array(z.string())
    .min(2)
    .describe("Tool names whose source_ref.quote shares this substring."),
  severity: SeveritySchema,
});
export type DuplicateQuote = z.infer<typeof DuplicateQuoteSchema>;

/**
 * Issues the auditor finds when cross-referencing manifest, server.ts,
 * tool files, and eval corpora — the housekeeping that runs cheap on the
 * same inputs as the source-grounding pass.
 */
export const ManifestConsistencyIssueSchema = z.object({
  kind: z.enum([
    "wired_tool_without_manifest_entry",
    "manifest_entry_without_wired_tool",
    "tool_file_without_eval_corpus",
    "eval_corpus_without_tool_file",
  ]),
  detail: z
    .string()
    .describe("What was missing or extra, named explicitly."),
  severity: SeveritySchema,
});
export type ManifestConsistencyIssue = z.infer<
  typeof ManifestConsistencyIssueSchema
>;

/**
 * Issues the auditor finds when reading `config.json` and cross-checking
 * the characterizer's prompt against the manifest. These route to the
 * characterizer for fixes, not the tool-builder.
 */
export const FacilitatorCoherenceIssueSchema = z.object({
  kind: z.enum([
    "tool_name_unknown_in_manifest",
    "manifest_tool_unreferenced_in_prompt",
    "outcome_tier_mismatch",
    "uncovered_flag",
  ]),
  tool: z
    .string()
    .optional()
    .describe(
      "The tool involved, when applicable. Omitted only for issues " +
        "that span multiple tools or the prompt structure as a whole."
    ),
  detail: z
    .string()
    .describe(
      "Specific detail — for outcome_tier_mismatch, list both the manifest's tiers " +
        "and what the prompt narrates; for uncovered_flag, name the flag."
    ),
  severity: SeveritySchema,
});
export type FacilitatorCoherenceIssue = z.infer<
  typeof FacilitatorCoherenceIssueSchema
>;

/**
 * The full audit report. The auditor returns this as a single JSON object
 * in its final response.
 *
 * `overall_severity` is the single field the orchestrator inspects to
 * decide whether to iterate. `summary` is the human-readable digest
 * surfaced at end of generation.
 */
export const AuditorReportSchema = z.object({
  runner_name: z
    .string()
    .min(1)
    .describe("Runner directory basename — for cross-referencing in logs."),
  source_grounding: z.object({
    per_tool: z.array(ToolGroundingResultSchema),
    duplicate_quotes: z.array(DuplicateQuoteSchema),
  }),
  manifest_consistency: z.object({
    issues: z.array(ManifestConsistencyIssueSchema),
  }),
  facilitator_coherence: z.object({
    issues: z.array(FacilitatorCoherenceIssueSchema),
  }),
  overall_severity: z
    .enum(["ok", "warnings_only", "has_blockers"])
    .describe(
      "ok = nothing to surface. " +
        "warnings_only = surface to human at end of generation, no re-delegation. " +
        "has_blockers = orchestrator re-delegates to fix blockers, then re-runs the auditor."
    ),
  summary: z
    .string()
    .min(1)
    .describe(
      "Plain-language summary the orchestrator can read into its own response. " +
        "Should mention severity, total issues by category, and the most important findings."
    ),
});
export type AuditorReport = z.infer<typeof AuditorReportSchema>;

/**
 * Parse and validate an auditor report from a JSON string. Returns either
 * a typed report or a structured error suitable for the orchestrator to
 * surface as "auditor returned malformed report — re-running."
 *
 * Used from harness code that wants typed access; the orchestrator agent
 * itself reads the JSON and the schema description.
 */
export function parseAuditorReport(
  rawJson: string
): { ok: true; report: AuditorReport } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      ok: false,
      error: `Auditor report is not valid JSON: ${(e as Error).message}`,
    };
  }
  const result = AuditorReportSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Auditor report failed schema validation:\n${result.error.toString()}`,
    };
  }
  return { ok: true, report: result.data };
}

/**
 * Compute `overall_severity` from the constituent issue lists. The auditor
 * is supposed to set this itself, but exposing the rule lets the harness
 * verify the auditor's self-classification — if the auditor says `ok` but
 * has blockers in its lists, that's a self-inconsistent report.
 */
export function computeOverallSeverity(
  report: Pick<
    AuditorReport,
    "source_grounding" | "manifest_consistency" | "facilitator_coherence"
  >
): "ok" | "warnings_only" | "has_blockers" {
  const allFindings: Array<{ severity: Severity }> = [
    ...report.source_grounding.per_tool,
    ...report.source_grounding.duplicate_quotes.map((d) => ({
      severity: d.severity,
    })),
    ...report.manifest_consistency.issues,
    ...report.facilitator_coherence.issues,
  ];
  if (allFindings.some((f) => f.severity === "blocker")) {
    return "has_blockers";
  }
  if (allFindings.some((f) => f.severity === "warning")) {
    return "warnings_only";
  }
  return "ok";
}
