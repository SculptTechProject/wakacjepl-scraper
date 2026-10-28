# Contributing

Use the Bun version in `.bun-version` and install with `bun install --frozen-lockfile`.
Run `bun run typecheck` and `bun test` before opening a pull request.

Keep changes focused. Validate external payloads as `unknown`, preserve native
transport errors, and add a regression test when changing collection or storage
behavior. Tests use mocked Fetch responses or isolated SQLite databases; they
must not contact third-party services.

Never include credentials, session cookies, traffic captures or your local
database. `.env.example` contains configuration names only. Synthetic examples
must be labeled as such. Describe any change to identity keys, coverage checks
or schema migrations explicitly.
