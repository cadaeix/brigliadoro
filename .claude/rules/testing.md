# Testing rules

Loads when working in `tests/` or on `*.test.ts` files.

## Tests are not optional in this project

Brigliadoro generates code (game tools, prompts, configs) and ships runners that other people will play. Untested generated tools fail silently in unhelpful ways — a misclassified outcome tier looks fine in transcripts but corrupts the facilitator's hint stream. Treat test coverage as a hard requirement, not a nice-to-have.

If asked to skip tests for speed, push back and write the tests. If a test is failing, fix the cause, don't delete the test or relax the assertion. Never `--no-verify` a commit.

## Validator subagent: Gate 1 differential tests

Generated tools are tested against the primitive oracle: feed the same inputs to the primitive directly and to the generated tool, assert the mechanical result matches. This is the load-bearing test layer — it catches generator drift before it reaches play.

Deep test patterns live in `src/meta/prompts/references/testing-reference.md`. Read before adding new test categories.

## Eval corpus is part of testing

`evals/*.triggers.json` for each generated tool measures trigger-rate quality. Positives must distribute across categories of trigger condition, not cluster. A failing eval is a failing test.

## Test material lives in `test ttrpgs/`

- `test ttrpgs/` — reference PDFs and links organized by complexity, generator targets.
- `test ttrpgs/mechanic test ttrpgs/` — purpose-built CC0 one-page games that isolate specific mechanical patterns (pausable dice-assignment, branch-gated pausable, decreasing clocks, random tables, GMless shared authority, etc.). Each game targets one coverage gap. Add more as new patterns need coverage.

When fixing a generator bug, prefer adding a mechanic test ttrpg that exercises the broken path over patching the generator alone.
