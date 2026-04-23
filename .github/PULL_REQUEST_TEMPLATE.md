## What

Brief description of the change.

## Why

Link to feature spec (F-XXX-YYY) from `docs/GarageOS-Specifiche.md` §3
or to the business rule (BR-XXX) from `docs/APPENDICE_F_BUSINESS_LOGIC.md`
that motivated this change.

## Implementation notes

- Key architectural choices made
- Anything non-obvious in the diff

## Tests

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual smoke test on local env
- [ ] BR-XXX rules verified (list them)

## Screenshots (if UI)

<!-- attach screenshots or recordings when touching the web or mobile app -->

## Checklist

- [ ] Code follows conventions in `CONTRIBUTING.md`
- [ ] Types compile (`pnpm typecheck`)
- [ ] Linter clean (`pnpm lint`)
- [ ] Formatting clean (`pnpm format:check`)
- [ ] Tests pass (`pnpm test:unit` and `pnpm test:integration`)
- [ ] No new `console.log`, no commented-out code
- [ ] Secrets not committed (verify with `git diff --staged`)
- [ ] Documentation updated if API / BR / schema changed
