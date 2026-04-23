# CLAUDE.md

This file provides guidance to Claude Code when working on the GarageOS repository.

## Project overview

GarageOS is a multi-tenant SaaS that digitizes vehicle maintenance logbooks for Italian mechanical workshops. Workshops (tenants) register interventions on vehicles; customers (B2C) see their vehicle history in a mobile app.

**Tech stack:**
- Backend: Fastify + TypeScript + Prisma
- Database: Supabase PostgreSQL (DB-only mode — we don't use Supabase Auth or Storage)
- Web app (officine): React + Vite + Tailwind + shadcn/ui
- Mobile app (clienti): React Native + Expo managed workflow
- Infrastructure: AWS via CDK (App Runner, Cognito, S3, EventBridge, SES, CloudFront, Route 53, WAF)

## Documentation hierarchy

**Always consult the relevant documentation before implementing a feature.** The repo contains ~13,000 lines of specifications in `docs/`:

| File | When to read |
|---|---|
| `docs/GarageOS-Specifiche.md` | Master document — start here for any feature |
| `docs/APPENDICE_A_API.md` | Implementing or calling REST endpoints |
| `docs/APPENDICE_B_DATABASE.md` | Schema changes, migrations, Prisma queries, RLS |
| `docs/APPENDICE_C_INFRASTRUCTURE.md` | AWS, CDK, GitHub Actions, deployment |
| `docs/APPENDICE_E_TESTING.md` | Writing tests, choosing test type |
| `docs/APPENDICE_F_BUSINESS_LOGIC.md` | **ALWAYS read before implementing business logic** — 130+ coded business rules |
| `docs/APPENDICE_G_ERROR_CODES.md` | Throwing or handling errors, API error responses |

**Rule:** when a documentation file conflicts with your instinct, the documentation wins. If you think the documentation is wrong, raise it in the PR description — do not silently diverge.

## Business rules are non-negotiable

`docs/APPENDICE_F_BUSINESS_LOGIC.md` contains rules coded as `BR-XXX`. Examples:

- `BR-001` — VIN uniqueness
- `BR-020` — garage_code format
- `BR-040` — one active owner per vehicle
- `BR-062` — wiki editing window for interventions
- `BR-151` — customer PII visibility based on relation

When you implement a feature:
1. Grep for related `BR-XXX` codes in the doc
2. Cite them in code comments (e.g. `// See BR-068 for odometer validation rules`)
3. Write a test that verifies each BR (pattern in `docs/APPENDICE_E_TESTING.md` §8)

## Git workflow — MANDATORY

**Never commit directly to `main`.** Branch protection on the repo is not enforced technically (GitHub Free plan limitation) but we follow the workflow as if it were. This is a hard rule.

### Branch naming

Use prefixes:
- `feat/short-description` — new features
- `fix/bug-description` — bug fixes
- `chore/description` — maintenance (CI config, dependency bumps, tooling)
- `refactor/description` — refactoring without behavior change
- `docs/description` — documentation only
- `test/description` — test-only changes

Branch names are lowercase, hyphen-separated, concise.

**Examples:**
- ✅ `feat/vehicle-registration-endpoint`
- ✅ `fix/km-decrease-validation`
- ✅ `chore/update-prisma-to-5.23`
- ❌ `my-branch` (no prefix)
- ❌ `feat/Added_the_new_Vehicle_Endpoint` (wrong casing, underscores)

### Workflow for every change

```bash
# 1. Always start from updated main
git checkout main
git pull origin main

# 2. Create a feature branch
git checkout -b feat/short-description

# 3. Make changes, commit often with meaningful messages
git add -A
git commit -m "feat(api): add POST /vehicles endpoint"

# 4. Push to remote
git push origin feat/short-description

# 5. Open a PR on GitHub via web UI or `gh` CLI
# 6. Wait for review (the user will approve)
# 7. Merge via "Squash and merge" — never "Create a merge commit"
# 8. Delete the branch after merge
# 9. Sync local main
git checkout main
git pull origin main
git branch -D feat/short-description
```

### Force push

- ❌ **NEVER force-push to `main`.** This is irreversible and destroys shared history.
- ✅ Force-push on your own feature branches is acceptable (e.g. after rebase), but prefer `git push --force-with-lease` over `--force` to avoid overwriting unseen changes.

## Commit message convention — Conventional Commits

All commits follow [Conventional Commits](https://www.conventionalcommits.org/). This enables automatic CHANGELOG generation and semantic versioning in v1.1+.

**Format:**
```
<type>(<scope>): <short summary in imperative present>

[optional body]

[optional footer]
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `chore` — maintenance, tooling, deps
- `docs` — documentation only
- `test` — tests only
- `refactor` — code change without behavior change
- `perf` — performance improvement
- `ci` — CI/CD config change
- `build` — build system change
- `revert` — revert a previous commit

**Scopes** (for a monorepo):
- `api`, `web`, `mobile`, `database`, `infra`, `shared`, `e2e`, or `deps`

**Examples:**
- ✅ `feat(api): add POST /vehicles endpoint`
- ✅ `fix(web): correct login redirect loop on safari`
- ✅ `docs: update README tech stack`
- ✅ `chore(deps): bump prisma to 5.23`
- ✅ `test(api): add BR-068 km validation tests`
- ❌ `Added stuff` (no type, not imperative)
- ❌ `fix: bug` (too vague)

**Summary rules:**
- Lowercase first letter
- Imperative present ("add", not "added" or "adds")
- No trailing period
- Max 72 characters

**Body (optional):**
- Use when the commit needs explanation beyond the summary
- Explain **why**, not **what** (the diff shows what)
- Wrap at 72 chars

## Pull Request guidelines

### Title

PR title follows the same Conventional Commits format as commit messages:
- ✅ `feat(api): vehicle registration endpoint with garage_code generation`
- ❌ `New feature` or `Updates`

### Description

Every PR description must include:

```markdown
## What

Brief description of the change.

## Why

Link to the feature spec (F-XXX-YYY from docs/GarageOS-Specifiche.md §3) or
the business rule (BR-XXX from docs/APPENDICE_F_BUSINESS_LOGIC.md) that motivated this.

## Implementation notes

- Key architectural choices made
- Anything non-obvious in the diff

## Tests

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual smoke test on local env
- [ ] BR-XXX rules verified (list them)

## Screenshots (if UI)

[attach]

## Checklist

- [ ] Code follows conventions in CONTRIBUTING.md
- [ ] Types compile (`pnpm typecheck`)
- [ ] Linter clean (`pnpm lint`)
- [ ] Tests pass (`pnpm test:unit` and `pnpm test:integration`)
- [ ] No new `console.log`, no commented-out code
- [ ] Secrets not committed (verify with `git diff --staged`)
- [ ] Documentation updated if API/BR/schema changed
```

### PR size

- Target: **<500 lines changed** per PR
- Hard limit: **<1500 lines**
- If a change is inherently bigger (e.g. initial scaffold), split into smaller PRs or explicitly justify in the description
- Giant PRs are hard to review and hide bugs

### Merge method

**Always use "Squash and merge"**. Never "Create a merge commit" or "Rebase and merge".

Rationale:
- Linear history on `main`
- Every commit on `main` = one feature/fix (easy to revert)
- Avoids merge commits polluting log

The squash commit message should be the PR title + a reference to the PR number (GitHub auto-generates this).

## Things Claude Code must NEVER do

1. **Never commit secrets.** Even in `.env.example`, use placeholder values. Real secrets go to AWS Secrets Manager or `.env` (gitignored).
2. **Never push to `main` directly.** Always open a PR.
3. **Never force-push to `main`.** On feature branches: use `--force-with-lease`, not `--force`.
4. **Never bypass CI failures** by disabling checks or merging with red status.
5. **Never delete the `main` branch** or rename it without explicit user approval.
6. **Never rewrite git history on `main`** (no `git commit --amend` or `git rebase -i` on merged commits).
7. **Never add a new npm/pnpm dependency** without justifying it in the PR description. Prefer standard library / existing deps.
8. **Never write migrations that drop columns or tables without user approval.** Follow the expand → migrate → contract pattern (see `docs/APPENDICE_B_DATABASE.md` §9.7).
9. **Never disable RLS policies** to "make tests pass." If a test fails because of RLS, the test setup is wrong, not the policy.
10. **Never commit `node_modules`, `.env`, `dist/`, `cdk.out/`, or any generated file.** Verify `.gitignore` covers them.

## When in doubt

1. **Stop and ask the user.** It's better to pause a task than to produce code that violates a hidden rule.
2. **Prefer small, reversible changes** over clever one-shot rewrites.
3. **Check `docs/`** — 90% of architectural questions are already answered.
4. **If the spec is ambiguous, note it in the PR description** and propose an interpretation — don't silently decide.

## Code style

- **TypeScript strict mode** enabled; no `any` without justification in comment
- **Prettier** for formatting (config in root `.prettierrc`)
- **ESLint** for linting (config in root `eslint.config.mjs`)
- **No emoji in code or commit messages** (emoji are fine in README, docs, PR descriptions)
- **Comments in English**, even if the documentation is in Italian (code is international; only user-facing strings are localized to Italian)
- **User-facing strings** (error messages, UI labels) are in Italian and go through the i18n system — never hardcoded

## Testing

Before opening any PR, run locally:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration   # requires Docker for Testcontainers
```

See `docs/APPENDICE_E_TESTING.md` for the full testing strategy, including which `BR-XXX` rules require explicit tests.

## Questions?

If you need clarification on any rule here or in the documentation, ask the user before proceeding. Reading the relevant `docs/APPENDICE_*.md` file usually answers the question.
