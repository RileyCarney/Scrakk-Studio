---
title: "ADR 0002: layering is checked by a test"
group: dev
order: 42
summary: "How the module layers in the architecture doc are enforced, and why existing violations are tracked as debt instead of fixed at once."
---
# ADR 0002: layering is checked by a test

**Status:** Accepted

## Context

`docs/dev/architecture.md` describes four areas and the direction of imports
between them. Nothing enforced it, and about 70 service files import from
features.

## Decision

- `tests/architecture-layers.test.ts` scans the imports and enforces two groups:
  - **Hard rules** with no exceptions: `shared` does not import `main`,
    `renderer` or `electron`; `main` does not import the renderer.
  - **Ratcheted debt**: services importing features, and UI components importing
    services, features or layout. The counts per file are in
    `tests/fixtures/layer-baseline.json`. A file may go down, never up, and a new
    file may not appear.
- The test is dependency-free. ESLint's TypeScript parser does not yet support
  the compiler version this repo uses.

## Consequences

- New violations fail `npm test` in CI.
- Removing a debt item means lowering its number in the baseline. The test
  fails if a listed file no longer exists, so the list stays accurate.
