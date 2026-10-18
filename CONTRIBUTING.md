# Contributing

This repository is a **published snapshot** of a package that is developed
inside a private monorepo. Issues and pull requests are welcome here; accepted
changes are ported into the monorepo by a maintainer and come back in the next
synced release (the commit message `sync: <sha>` and `.export-source` record
which private commit a snapshot came from).

- Open an issue before a large change so we can agree on the shape.
- Keep PRs focused; `pnpm run type-check` and `pnpm run build` must pass, and
  `node scripts/check-boundaries.mjs .` enforces that the package stays free of
  private/service dependencies.
- By contributing you agree your contribution is licensed under the repository's
  LICENSE.
