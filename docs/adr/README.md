# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for GarageOS.

## What is an ADR?

An ADR captures an important architectural decision made along with its context and consequences. ADRs help new team members and future maintainers understand **why** something was built the way it was, not just **what** was built.

We follow the [Michael Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): Status, Date, Context, Decision, Consequences.

## When to write an ADR

Write an ADR when a decision:

- Has long-term implications (hard or costly to reverse).
- Involves a trade-off between competing options.
- Is likely to be questioned or revisited later.
- Affects the shape of the system beyond a single feature.

Examples: choosing a runtime (Lambda vs container), choosing a database (Postgres vs DynamoDB), choosing a multi-tenant isolation strategy (shared DB + RLS vs schema-per-tenant), choosing a frontend framework.

**Do not** write an ADR for routine implementation choices (naming, file structure, library bump within a major version).

## How to add a new ADR

1. Copy `TEMPLATE.md` (if present) or use an existing ADR as a starting point.
2. Name the file `ADR-NNNN-short-kebab-case-title.md` where `NNNN` is the next sequential number (zero-padded to 4 digits).
3. Fill in all sections. Be concrete about alternatives considered — future readers will ask "why not X?".
4. Set `Status: Proposed` initially. Change to `Accepted` when the decision is formally adopted.
5. Once accepted, **do not edit** the ADR retroactively. If the decision is later reversed or modified, create a new ADR that supersedes the old one (and update the old one's status to `Superseded by ADR-XXXX`).
6. Add an entry to the index below.

## Index

| Number | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](./ADR-0001-lambda-over-app-runner.md) | Adopt AWS Lambda + API Gateway HTTP API instead of AWS App Runner for backend runtime | Accepted (amended by ADR-0002) | 2026-04-23 |
| [ADR-0002](./ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md) | Replace AWS Lambda Web Adapter with `@fastify/aws-lambda` in-process adapter | Accepted | 2026-04-29 |

## References

- [Documenting Architecture Decisions — Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ADR GitHub organization](https://adr.github.io/) — broader ADR community and tooling.
