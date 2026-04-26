/**
 * Schema for `runners/<name>/tools/manifest.json` — the tool-builder's
 * declared inventory of what it built and why.
 *
 * The manifest is a generator-side artefact: written by the tool-builder
 * after Step 7 (server assembly), read by the orchestrator's verification
 * step, and (when built) read by the coherence auditor subagent. Runners
 * do not consume it at play time.
 *
 * Why this exists:
 * - The orchestrator's verification step previously had to parse tool .ts
 *   files ad-hoc to extract names, descriptions, outcome-tier values, and
 *   game-specific flags. Brittle and limited.
 * - More importantly: the act of filling in `source_ref.quote` for every
 *   tool forces the tool-builder to prove each tool is grounded in source
 *   rules text, not source fiction. Invented tools struggle to fill the
 *   quote field, which makes invention auditable rather than only
 *   detectable through prose-warning compliance.
 *
 * The manifest structure mirrors what every downstream consumer (orchestrator
 * verification, coherence auditor, future per-tier narration writer) needs
 * to know about each tool, so they can read this once instead of
 * re-extracting from .ts source.
 */

import { z } from "zod";

/**
 * A claim the tool-builder makes about why a given tool exists.
 *
 * `summary` is the tool-builder's interpretation; `quote` is the evidence.
 * An auditor can verify the claim by checking whether the quote actually
 * appears in the source and whether it actually supports the summary.
 *
 * `quote` may be empty in narrow cases (a utility tool with no direct
 * source-rules counterpart). When empty, the summary should explain why,
 * and a downstream reviewer should treat the absence as a flag for
 * possible invention.
 */
export const SourceRefSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe(
      "One-line statement of what source mechanic this tool models. Short, declarative."
    ),
  quote: z
    .string()
    .describe(
      "Verbatim quote from the source rules text that justifies this tool's existence. " +
        "Empty string only if no rules text directly supports the tool — in which case the summary " +
        "should explain why (and a reviewer should treat empty quote as a flag for possible invention)."
    ),
  page_or_section: z
    .string()
    .optional()
    .describe(
      "Where in the source the rules text comes from. Page number, section name, or short locator. " +
        "Optional but useful for human auditing."
    ),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * One entry per facilitator-visible tool. The tool-builder writes one of
 * these for every tool it wires into server.ts.
 */
export const ToolManifestEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("MCP tool name (snake_case, the first argument to tool())."),
  file: z
    .string()
    .min(1)
    .describe("Tool file path relative to tools/, e.g. 'my-action.ts'."),
  description: z
    .string()
    .min(1)
    .describe(
      "The exact description string passed to tool() — what steers facilitator selection."
    ),
  params: z
    .record(z.string())
    .describe(
      "Parameter name → short description of what each param is. Pulled from the zod schema's .describe() calls."
    ),
  outcome_tiers: z
    .array(z.string())
    .describe(
      "Exact string values from the tool's OutcomeTier type. " +
        "['generated'] for pure content generators."
    ),
  flags: z
    .array(z.string())
    .describe(
      "Game-specific flags returned in the result (snake_case). " +
        "Empty array if the tool returns no game-specific flags."
    ),
  shape: z
    .enum(["one-shot", "pausable"])
    .describe(
      "'one-shot' if the tool resolves in a single call. 'pausable' if it uses the start/continue state-machine pattern."
    ),
  resources_emitted: z
    .array(z.string())
    .describe(
      "Names of session resources this tool writes (e.g. 'markers', 'stress'). " +
        "Empty array if the tool doesn't touch SessionStore for writes."
    ),
  resources_consumed: z
    .array(z.string())
    .describe(
      "Names of session resources this tool reads. " +
        "Empty array if the tool doesn't read SessionStore."
    ),
  source_ref: SourceRefSchema,
});

export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;

/**
 * The full manifest. `version: 1` lets us evolve the schema without
 * breaking existing runners' archived manifests.
 */
export const ToolManifestSchema = z.object({
  game_name: z
    .string()
    .min(1)
    .describe("Name of the game (matches config.json's name field)."),
  version: z
    .literal(1)
    .describe("Manifest schema version. Always 1 for now."),
  tools: z
    .array(ToolManifestEntrySchema)
    .describe("One entry per facilitator-visible tool wired into server.ts."),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/**
 * Parse and validate a manifest from a JSON string. Returns either a typed
 * manifest or a structured error report suitable for passing back to the
 * tool-builder for repair.
 *
 * Use from harness code or from inside tooling that wants typed access. The
 * orchestrator agent does its own validation through reading the JSON and
 * the schema description; this helper exists for callers that want to fail
 * fast programmatically.
 */
export function parseManifest(
  rawJson: string
): { ok: true; manifest: ToolManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      ok: false,
      error: `Manifest is not valid JSON: ${(e as Error).message}`,
    };
  }
  const result = ToolManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Manifest failed schema validation:\n${result.error.toString()}`,
    };
  }
  return { ok: true, manifest: result.data };
}
