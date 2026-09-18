# Releasing watukuy

Releases are driven by [Changesets](https://github.com/changesets/changesets) and published from
GitHub Actions with npm provenance. Nothing is published from a laptop.

## One-time setup (before the first publish)

1. **npm trusted publishing (preferred).** On npmjs.com, open the `watukuy` package settings →
   *Trusted publishers* → add GitHub Actions with repository `keynertyc/watukuy` and workflow
   `release.yml`. Trusted publishing needs the package to exist, so the very first publish uses a
   token (step 2); switch to trusted publishing right after and delete the token.
2. **First publish with a token.** Create a granular automation token on npmjs.com with publish
   rights, add it as the repository secret `NPM_TOKEN`, run the *Release* workflow from the Actions
   tab. The workflow publishes with `--provenance` because it has `id-token: write`.
3. After the package exists and trusted publishing is configured, remove `NPM_TOKEN` and, if you
   want automatic releases, change `on:` in `.github/workflows/release.yml` to
   `push: { branches: [main] }`.

## Cutting a release

* Every user-visible change lands with a changeset (`pnpm changeset`).
* Stable releases: `pnpm version` (Changesets) bumps `package.json` and writes `CHANGELOG.md`;
  commit the bump and run the Release workflow, which publishes the committed version to `latest`,
  removes any leftover pre-release dist-tag, and deprecates that version's pre-releases.
* Pre-releases (optional, for future betas): `pnpm exec changeset pre enter beta`, then the same
  `pnpm version` + Release flow publishes `x.y.z-beta.N` under the `beta` dist-tag.
* Tag the commit (`git tag -a vX.Y.Z -m "watukuy X.Y.Z"`), push tags, and create the GitHub
  release from `CHANGELOG.md` (`gh release create vX.Y.Z --notes-file ...`).

## Checks that must be green before publishing

`pnpm check` (lint, typecheck, tests with coverage thresholds), `pnpm build` (tsdown with
`publint` and `attw`), `pnpm size`, `pnpm test:workerd`, `pnpm test:bun`.
