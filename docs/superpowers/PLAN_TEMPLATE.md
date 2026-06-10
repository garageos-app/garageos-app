# Implementation Plan Template

Guidance for writing implementation plans in `docs/superpowers/plans/`. Calibrated for current-generation models (Fable 5+): plans describe **contracts, not dictation**. See `CLAUDE.md` § "Right-sizing the workflow to the task" for how much process a change deserves.

## Principles

1. **Contract over verbatim.** Describe files, interfaces, behaviors, BR-XXX rules to cite, and test cases to cover. Include verbatim code **only** where the exact detail is the point: wire shapes (request/response envelopes, query keys), user-facing Italian strings, regexes/validators, migration SQL. Verbatim code copied into plans has historically been a *source* of bugs (invented schema fields, stale method names) — the implementer must verify against the real code anyway.
2. **The code wins over the spec.** Every plan has a "Deviations from spec" section listing where the spec was verified wrong against the actual codebase, with file:line evidence.
3. **No hardcoded model names or commit trailers.** Do not prescribe reviewer models (sonnet/opus) and do not embed `Co-Authored-By:` lines in planned commit messages — the harness appends the current model's trailer automatically. Old plans containing `Co-Authored-By: Claude Opus 4.7 ...` are stale; do not copy them.
4. **Plans are executed via** `superpowers:subagent-driven-development` (large slices) or `superpowers:executing-plans` / direct implementation (small-medium). Review per CLAUDE.md right-sizing: final whole-branch `/code-review` is always the gate.

## Header (every plan)

```markdown
# <F-XXX-YYY / scope> — <title> — Implementation Plan

**Goal:** one paragraph.
**Architecture:** key choices, mirrored sibling patterns (file paths).
**Spec:** link to docs/superpowers/specs/<file>.md
**LOC budget:** target ~N net, hard PR limit 1500. Controller checks cumulative LOC after each task; halt and ask at ~80% of the limit.

## Deviations from spec (verified against actual code — the code wins)
## Gotchas the implementer MUST respect (from project memory)
## Branch
```

## Task format

Per task: **Files** (Create/Modify/Test), the behavioral contract (inputs, outputs, error codes, BR-XXX to cite in comments), test cases described by intent (TDD red → green), and the planned commit message (Conventional Commits, summary ≤ 72 chars — validate length at plan time, commitlint is a hard CI gate on every PR commit).

## Pre-flight checklist (run BEFORE dispatching implementers)

Consolidated from 50+ PR retrospectives. Each item exists because skipping it shipped (or nearly shipped) a bug.

### Schema & Prisma

- [ ] For every Prisma operation in the plan, grep `schema.prisma`: model exists, **every `select`/`data` field exists with the exact name**, unique constraints match (compound `@@unique` uses field-name composition, not `map:` name). Typecheck does NOT catch excess/renamed fields in `create`/`update` data or loose `where` keys.
- [ ] After any schema field rename, grep production routes AND tests for the old name — the cascade is not limited to fixtures.
- [ ] For any DTO derived from a `Json` column, grep the canonical shape (BR doc + Zod schema + seed examples) and assert it field-by-field in the plan.
- [ ] For integration tests doing `UPDATE ... SET col = NULL`, check the column is nullable; raw SQL INSERTs on tables with `@updatedAt` must set `updated_at` explicitly.
- [ ] For Prisma method changes (e.g. `create` → `createMany`), grep `packages/api/tests/` for the old method name (FakePrisma interfaces + `.mock.calls` assertions break silently until CI).

### Docs cross-reference (BR / error codes / API)

- [ ] Grep `APPENDICE_F` for **every** BR-XXX the spec mentions or proposes — number collisions have shipped twice; confirm the rule text matches what you cite.
- [ ] Grep `APPENDICE_G` for error codes before inventing new ones — entire code families may already be registered.
- [ ] Grep target file paths before declaring "Create X" — the file may already exist from a previous slice.

### RLS & DB constraints

- [ ] For any new route reading an RLS-protected table, grep migration history for the SELECT policy: if permissive (`USING (true)`), use `findFirst({ id, tenantId })` + manual 404, NOT `findUniqueOrThrow` + P2025. Cross-tenant 404 integration test is mandatory for every `GET /v1/<resource>/:id`.
- [ ] Customer/tenant endpoints MUST filter at the application layer too — never rely on RLS alone.
- [ ] For error-code test scenarios on CHECK-constrained fixtures, verify the path is reachable given CHECK + route filter combined. CHECK violations are visible only on CI (real Postgres).
- [ ] For cascade/delete behavioral tests, grep policies on the parent table — no `FOR DELETE` policy means default-deny (structural test only).

### Tests & refactors

- [ ] For refactor extractions, compare removed lines for inline guards/validations — they must reappear in the extracted helper.
- [ ] Mocks must thread dynamic input via `mockImplementation`, not hardcoded values; integration test helpers must mirror the exact frontend wire shape (content-type, body) and assert exact serialized formats (e.g. date-only fields).
- [ ] Unit mocks with `aggregate`/`max` values that make the assertion tautological (always passes) must be flipped to prove the code path.
- [ ] Route-handler changes: run the targeted `pnpm --filter @garageos/api test:unit` locally — typecheck doesn't catch broken FakePrisma mocks.

### Infra & runbooks

- [ ] For every new CDK resource type, grep infra tests for `resourceCountIs` assertions on that type (infra test:unit is CI-only — invisible locally).
- [ ] For cross-construct `iam:PassRole` extension methods, grep the target construct's policies for token references — latent CFN cycle; use a literal-name string prop.
- [ ] New Cognito/S3/SES calls in Lambda: verify the IAM action is granted in `lambda-api.ts` (6+ recurring gap instances found only at smoke).
- [ ] Runbook commands: cross-reference `--stack-name` with `bin/<app>.ts`; dry-run shell-specific syntax in the target shell (PowerShell vs bash).
- [ ] New migrations are operator-applied (`db:migrate:deploy` with DIRECT_URL) — deploy.yml ships CDK only; note it in the runbook.

### Style & process

- [ ] Comment headers in English (watch for Italian copied from APPENDICE_F); user-facing strings in Italian via i18n.
- [ ] After fixing/renumbering a BR, grep ALL call sites and comment headers citing it.
- [ ] When spec claims "≥N files" but grep finds fewer, document the discrepancy — never pad the diff.

## Review gates (in order)

1. Per-task review only where CLAUDE.md right-sizing requires it.
2. `pnpm -r typecheck` (pre-push hook) — the only mandatory local gate.
3. **Final whole-branch `/code-review`** (high effort; ultra for the biggest slices) — load-bearing, never skip.
4. CI full matrix (`gh pr checks --watch`) — the only gate for CHECK constraints, RLS semantics, real-Postgres behavior.
5. Smoke runbook for UI/shell/device-facing PRs — BLOCKER, no review replaces it.
