# Stability policy

## Versioning

watukuy follows [Semantic Versioning 2.0](https://semver.org). From `1.0.0`:

- **Major**: any breaking change to the public API (below), to persisted state formats that cannot be migrated automatically, or to the event id material.
- **Minor**: new features, new options with defaults that preserve existing behavior, new exports, new store capabilities, new hooks, new metrics.
- **Patch**: bug fixes and documentation. A fix that changes observable behavior is still a patch when the previous behavior contradicted the documented guarantees.

Pre-release versions (`1.0.0-rc.x`) may change anything between releases.

## What is public API

Covered by semver:

- Every runtime export and type exported from `watukuy` and the subpaths `watukuy/store-sqlite`, `watukuy/store-postgres`, `watukuy/store-redis`, `watukuy/nestjs`, `watukuy/otel`, `watukuy/sinks`, `watukuy/testing`, and the `watukuy` CLI's commands and flags.
- The behavior described in [guarantees.md](./guarantees.md) and the defaults listed in [api.md](./api.md).
- The event envelope (`WatukuyEvent`), the CloudEvents mapping (`toCloudEvent`), and the **event id material** (`watukuy|v1|...`): ids are stable across releases so consumer dedup tables keep working.
- The `StateStore`, `RateBudgetStore`, `Clock`, `Random`, `Logger`, and `Hooks` ports. Adding an **optional** method to a port is a minor change; adding a required method is a major change.
- Error class names and `code` values.
- Span and metric names emitted by `watukuy/otel`; attribute names may gain additions in minors.
- SQL table names and the migration mechanism (`store.migrate()`, `watukuy migrate`). Migrations are forward-only and idempotent; a minor release may add tables, columns, or indexes and ship the migration; it never drops or renames without a major.

Not covered:

- Anything under `src/` not re-exported from an entry point, including `ResolvedPoller` internals, the runner, dispatcher, and cursor strategy objects (exported as types for adapters, but their shape may change in minors).
- Log message text and `debug`/`info` log metadata.
- The exact wording of error messages (the `code` is stable, the message is not).
- The JSON shape of persisted cursors and `PollerState` beyond what the same store version reads back. Do not build tooling on the raw store contents; use `inspect()` and the CLI.
- Timing details that are not guarantees: exact jitter distribution, AIMD factors, lease heartbeat cadence.
- The `FakeApi` HTTP route layout in `watukuy/testing`.

## Supported runtimes

| Runtime | Support |
|---|---|
| Node.js 22.12+, 24, 26 | full; CI matrix |
| Bun (latest) | core suite in CI; stores best-effort |
| Cloudflare Workers (`workerd`) | core with `MemoryStore` or `PostgresStore` over Hyperdrive; best-effort |
| Deno | core expected to work (WinterTC APIs only); not in CI |

`engines.node` is `>=22.12`, the floor for `require(esm)`. When a Node major reaches end of life it is dropped from the matrix in the next minor and the `engines` field is raised in the next major.

TypeScript: the published types target TypeScript 5.5+ with `strict`. `exactOptionalPropertyTypes` is supported (every optional option accepts `undefined` explicitly). Types are checked with `arethetypeswrong` on the packed tarball in CI.

Peer dependency ranges: `@nestjs/common` and `@nestjs/core` `>=11 <13`, `@opentelemetry/api` `^1.9`, `pg` `>=8`, `redis` `>=4`, `ioredis` `>=5`, `vitest` `>=3` (for `watukuy/testing`). All optional.

## Deprecation policy

1. A deprecated export or option keeps working for **at least one minor release** and is marked with `@deprecated` JSDoc naming the replacement and the removal version.
2. Where it is cheap to detect, using a deprecated option logs one `warn` per process at startup.
3. Removal happens in the next major, listed in the changelog's breaking-changes section with a migration note.
4. Behavior changes that affect what handlers receive (new event fields are fine; changed semantics are not) are never made in a minor.

## Release process

Changesets drive versioning and the changelog. Releases are published from GitHub Actions through npm trusted publishing (OIDC) with provenance attestations; there are no `postinstall` scripts, no runtime dependencies, and the lockfile is committed. Each release runs `publint`, `arethetypeswrong`, and `size-limit` (core entry ≤ 20 kB min+gzip) on the packed tarball.

## Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on the repository. You will receive an acknowledgement within 48 hours and a fix or mitigation plan within 14 days for confirmed issues. Details in [SECURITY.md](../SECURITY.md). Supported for security fixes: the latest `1.x` minor.

Related: [api.md](./api.md), [guarantees.md](./guarantees.md).
