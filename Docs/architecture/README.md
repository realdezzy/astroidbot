# Architecture notes

Engineering documentation, kept out of `Docs/` proper because that directory is
the product's user-facing documentation site: `src/api/routes/docs.ts` reads
every `.md` at its top level and serves it at `/api/docs`. It does not recurse,
so files in here are for the repo and not for users.

`chains.md` and `market-data.md` were deleted in 572a0b8 while converting
`Docs/` into that site. CLAUDE.md still directs readers to both — they are the
documents its indexer and chain-abstraction sections lean on hardest — so they
are restored here rather than left as dangling references.

- **[chains.md](chains.md)** — `ChainId` vs `ChainFamily`, descriptors, and the
  adapter hierarchy. Read before adding a chain.
- **[market-data.md](market-data.md)** — the indexer: cursor ordering, the
  refusal to step over unreadable ranges, the split-only-on-oversize retry
  rule, and the USD-anchor fallback chain. Read before touching ingestion.
