# Architecture decisions (confirmed working)

One-line: Node 26 native TS + Express + Knex/Postgres 16 + trigger-enforced ledger invariants.

- Node 26 runs `.ts` directly (type stripping) — no build step; scripts, server, and knex
  migrations all run as plain `node file.ts`. Knex migrations use a **static in-code
  migrationSource** (src/migrations/index.ts) because knex's fs loader can't load TS.
- Ledger invariants live in **Postgres triggers**, not just app code:
  `je_immutable`/`jl_immutable` (block UPDATE/DELETE on posted, INSERT into posted),
  `je_check_balanced` (deferred constraint trigger: balance in txn+base currency,
  ≥2 lines, closed-period block). App-level postEntry() validates too, but the DB is
  the invariant of record — verified by direct-SQL tampering tests.
- Money: NUMERIC in PG returned as **strings** (pg typeParser), decimal.js for math,
  2dp ROUND_HALF_UP via money(). Never floats.
- FX: entry stores currency + rate; lines store txn amounts AND base amounts. Per-line
  conversion rounding residual goes to a dedicated base-only rounding line
  (txn debit=credit=0 is allowed by CHECK when base side nonzero).
- Entry numbering: `companies.next_entry_no` via increment().returning() — rolls back
  atomically with failed posts.
- Test DB is khata_test (vitest.config env), dev is khata_dev. Postgres via
  `brew services start postgresql@16`, binaries at /opt/homebrew/opt/postgresql@16/bin.
