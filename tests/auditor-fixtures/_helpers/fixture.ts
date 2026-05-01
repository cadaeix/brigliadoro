/**
 * Helpers for the auditor fixture suite.
 *
 * Each fixture is a small hand-crafted runner directory under
 * `tests/auditor-fixtures/<name>/`. The shared source — a tiny CC0
 * micro-RPG called The Cipher — lives at `_shared/the-cipher.md` and
 * is referenced by every fixture's manifest via the same path.
 *
 * Tests call `auditFixture("name")` to run the auditor against a fixture
 * and get back a typed report; the test then asserts on the report's
 * shape. Schema-validation failures and JSON-extraction failures throw
 * with a diagnostic so the test surfaces the real cause.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runAuditor, type AgentModel } from "../../../src/meta/auditor-runner.js";
import type { AuditorReport } from "../../../src/meta/auditor.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_ROOT = path.dirname(path.dirname(__filename));

/** Absolute path to the fixture directory for a given variant. */
export function fixturePath(name: string): string {
  return path.join(FIXTURES_ROOT, name);
}

/** Absolute path to the shared source file. */
export const SHARED_SOURCE_PATH = path.join(
  FIXTURES_ROOT,
  "_shared",
  "the-cipher.md"
);

/**
 * Run the auditor against a named fixture and return its parsed report.
 * Throws (with the runAuditor error string + raw response) on schema or
 * extraction failure, so test assertions land on a typed value.
 *
 * The auditor model defaults to Haiku — the auditor is mechanical work
 * and Haiku is what the production pipeline uses. Override with `model`
 * if you want to A/B against Sonnet for calibration spot-checks.
 */
export async function auditFixture(
  name: string,
  options: { model?: AgentModel } = {}
): Promise<AuditorReport> {
  const result = await runAuditor({
    runnerDir: fixturePath(name),
    sourcePath: SHARED_SOURCE_PATH,
    model: options.model,
    runnerName: name,
  });
  if (!result.ok) {
    throw new Error(
      `Auditor failed on fixture "${name}": ${result.error}\n\n` +
        `Raw response:\n${result.raw}`
    );
  }
  return result.report;
}
