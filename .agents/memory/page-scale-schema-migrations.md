---
name: Page-scale schema migrations
description: Safely evolve document-wide scales into per-page rows in the development database.
---

# Page-scale schema migrations

When introducing a non-null page key to existing document scale rows, add and
backfill the page number before replacing the primary key.

**Why:** The schema push tool may attempt to set `NOT NULL` before the new
column exists on older development databases. Backfilling legacy rows to page 1
preserves their scale data and lets the new composite key be applied safely.

**How to apply:** For a legacy document-wide scale table, make the new page
column nullable first, set every existing row to page 1, then apply its default,
not-null constraint, and composite `(document_id, page_number)` primary key in
one transaction. Verify the normal schema push is clean afterward. Replit's
Publish flow owns production schema changes; application reads should still
normalize legacy unit rows so users retain an equivalent page-one scale during
the rollout.