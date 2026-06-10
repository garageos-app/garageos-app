# Contributing to GarageOS

This document describes how to contribute to the GarageOS codebase. It applies to human contributors and to AI coding assistants (Claude Code).

## Before you start

1. Read `README.md` for project overview
2. Read the relevant documentation in `docs/` for the area you're touching
3. For Claude Code: read `CLAUDE.md` in the repo root for AI-specific rules

## Git workflow

### Branch naming

Use prefixes:

- `feat/short-description` — new features
- `fix/bug-description` — bug fixes
- `chore/description` — maintenance (CI, config, tooling)
- `refactor/description` — refactoring without behavior change
- `docs/description` — documentation only
- `test/description` — test-only changes

Branch names are lowercase, hyphen-separated, concise.

### Workflow

```bash
# 1. Start from updated main
git checkout main
git pull origin main

# 2. Create a branch
git checkout -b feat/my-feature

# 3. Work, commit, push
git add -A
git commit -m "feat(api): add new endpoint"
git push origin feat/my-feature

# 4. Open a PR on GitHub
# 5. Get review + approval
# 6. Squash and merge
# 7. Delete branch, sync local main
git checkout main
git pull origin main
git branch -D feat/my-feature
```

### Rules

- **No direct commits to `main`.** Even if branch protection isn't technically enforced, we follow the rule.
- **No force-push to `main`.** Ever.
- **Force-push on feature branches** is ok, but use `git push --force-with-lease` instead of `--force`.
- **Keep PRs small.** Target <500 lines changed, hard limit <1500.

## Commit messages — Conventional Commits

Format:

```
<type>(<scope>): <imperative summary>

[optional body explaining why]
```

**Types:**
`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`, `revert`

**Scopes:**
`api`, `web`, `mobile`, `database`, `infra`, `shared`, `e2e`, `deps`

**Examples:**

- `feat(api): add POST /vehicles endpoint`
- `fix(web): correct login redirect on safari`
- `docs: update README tech stack`
- `chore(deps): bump prisma to 5.23`
- `test(api): add BR-068 km validation tests`

**Rules:**

- Lowercase first letter after the type
- Imperative present tense ("add", not "added")
- No trailing period
- Max 72 chars for the summary line
- Body (if needed) explains **why**, not **what**

## Pull requests

### Title

Same format as commit messages:

- ✅ `feat(api): vehicle registration with garage_code generation`
- ❌ `New vehicle feature`

### Description template

```markdown
## What

Brief description of the change.

## Why

Link to feature spec (F-XXX-YYY) or business rule (BR-XXX) from docs/.

## Implementation notes

- Architectural choices
- Anything non-obvious

## Tests

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual smoke test
- [ ] BR-XXX rules verified

## Screenshots (if UI)

## Checklist

- [ ] Follows CONTRIBUTING.md
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test:unit` and `pnpm test:integration` pass
- [ ] No console.log, no commented code
- [ ] No secrets committed
- [ ] Docs updated if API/schema/BR changed
```

### Merge method

**Always "Squash and merge".** This keeps `main` history linear.

### Review requirements

- Min 1 approval (human contributors)
- All conversations resolved
- All CI checks green

**AI-assisted PRs (Claude Code):** the repo owner has authorized Claude Code to squash-merge its own PRs using admin bypass of the 1-approval rule, **only** after the full review pipeline (see `CLAUDE.md` § "Self-merge rules") and with every CI check green. The owner can require manual review on any PR by saying so.

## Code style

- **TypeScript strict mode**. Avoid `any`; if necessary, justify with comment.
- **Prettier** auto-formats on save (see `.prettierrc`)
- **ESLint** enforces code rules (see `eslint.config.mjs`)
- **Comments in English**
- **User-facing strings in Italian**, via i18n system
- **No emoji in code/commits**

## Testing

Run before pushing:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration   # requires Docker
```

See `docs/APPENDICE_E_TESTING.md` for the full testing strategy, including which business rules (`BR-XXX`) must have explicit tests.

## Business rules

The documentation `docs/APPENDICE_F_BUSINESS_LOGIC.md` contains 130+ business rules coded as `BR-XXX`. When implementing a feature:

1. Identify applicable `BR-XXX` rules
2. Cite them in code comments
3. Write tests that verify the rules explicitly (see testing doc §8)

Example:

```typescript
/**
 * Creates a new intervention for a vehicle.
 * @see BR-061 for immutable fields rule
 * @see BR-068 for odometer_km non-decreasing rule
 * @see BR-069 for intervention_date validation
 */
async function createIntervention(input: CreateInterventionInput) {
  // ...
}
```

## Security

- **Never commit secrets** (API keys, DB passwords, tokens)
- `.env` is gitignored — use `.env.example` as template with placeholder values
- Real secrets go to AWS Secrets Manager (see `docs/APPENDICE_C_INFRASTRUCTURE.md` §8)
- Push protection is enabled on this repo — if you accidentally commit a secret, the push will be blocked

## Getting help

- Read the docs in `docs/` first
- If stuck, ask in the PR description or open an issue
- For AI assistants: if a rule is ambiguous, ask the user — don't silently decide

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project (Proprietary, all rights reserved).
