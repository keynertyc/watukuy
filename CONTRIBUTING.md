# Contributing to watukuy

Thanks for helping. The documented guarantees (`docs/guarantees.md`) and semantics (`docs/`) are
normative: behaviour must match them, or the docs are amended first in the same pull request.

## Development

```bash
pnpm install
pnpm check          # typecheck + lint + tests
pnpm test:watch
pnpm build
```

* Node >= 22.12, pnpm (pinned in `package.json`).
* Core modules (`src/core`, `src/scheduler`, `src/cursor`, `src/diff`, `src/budget`, `src/http`,
  `src/validate`) must not import `node:` modules. A test enforces this.
* Every behaviour change needs a test. Guarantees (see docs/guarantees.md) need an integration test and, where
  applicable, a chaos invariant.
* Public symbols need JSDoc with an example.
* Add a changeset (`pnpm changeset`) for anything user-visible.

## Commit and PR conventions

Small, focused PRs. Describe the guarantee or feature touched and link the relevant docs page.
