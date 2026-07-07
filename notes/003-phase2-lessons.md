# Phase 2 lessons: responsive drill-down UI + IFRS + live updates

One-line: derive every statement from one balance aggregation, and mount SSE before auth guards.

- **IFRS statements must reuse the trial-balance aggregation, not re-query.**
  All of SPL/SFP/SOCE are built on the exported `accountBalances()` helper from
  reports/service.ts (the same one the trial balance uses). This makes "ties to
  the TB" true by construction, not by luck. Verified: SPL profit === P&L net
  income, SFP totalAssets === sum of TB asset closings, SOCE closing === SFP
  equity total.
- **SSE endpoint MUST be mounted before the bearer-guarded router.** Express
  matches `/api/companies/:companyId/events` against the earlier
  `app.use('/api/companies', requireAuth, ...)` first, which 401s because
  EventSource can't send an Authorization header. Fix: register the events
  route immediately after `/api/auth`, before any `/api/companies` guard, and
  authenticate via a `?token=` query param re-checked in the handler. Symptom
  was a silent live-update failure (readyState=2 in the browser).
- **Live updates via one data bus.** api.ts fires `bumpData()` after any
  non-GET, and the SSE stream also calls it; useFetch subscribes and refetches
  SILENTLY (no loading flash). One EventSource per company opened in the shell.
  Debounced 150ms so a multi-entry posting refetches once.
- **Drill-down needs ids threaded through every report row.** Report builders
  now emit accountId/entryId alongside display strings; the JE list resolves
  (source_type, source_id) to a label + route via a shared resolveSourceRefs()
  so a ledger line always links to its document.
- **Responsive tables: render both, toggle with CSS.** Ship a `.hide-mobile`
  <table> and a `.mobile-cards` block; media query at 767px swaps them. Simpler
  and more reliable than JS width detection. Verified cards at 375px, persistent
  nav at 768px+, rail collapse (localStorage) on desktop.
- **Audit before/after**: capture the row BEFORE calling the update service,
  then store {before, after} in the audit details jsonb — the UI diffs them.
- **Seed must write the audit trail too.** Audit rows are written in the ROUTE
  layer (audit() after each service call); the seed calls services directly, so
  seeded documents had an empty /activity until we synthesized created/posted/
  paid audit rows at the end of the seed. Caught by fresh-context verification,
  not by the suite — so also added audit.api.test.ts (supertest through the real
  routes) asserting create+post populate audit and edits store before/after.
  Lesson: when a subagent verifies "feature X works", check it against the
  DEMO data path, not just the code path; seed and routes can diverge.
