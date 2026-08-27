-- Removing somebody from a household, without removing what they made (#127).
--
-- A member is what four tables record as the person who created a row —
-- `ingredient.created_by`, `recipe.created_by` and `.updated_by`,
-- `planned_batch.created_by`, `pantry_entry.added_by` — and the recipe list
-- and recipe screen join `member` to print that person's name. So DELETE was
-- never the right verb: for anybody who has actually used the app it either
-- breaks a foreign key or takes their recipes off the screen with them.
--
-- The first attempt at #127 refused to remove such a member at all, which
-- blocked the removal the issue asks for and, with it, the only move there is
-- — #127 defines moving somebody as removing them here and adding them there.
--
-- So removal is a stamp, not a delete. The row stays and keeps attributing
-- history; what goes is the household access it granted.
ALTER TABLE member ADD COLUMN removed_at TEXT;

-- `google_sub` is UNIQUE across the whole table, and the sub is the only thing
-- sign-in matches on. A removed member has to give theirs up — otherwise the
-- same person could never be added to another household, which is the second
-- half of a move.
--
-- Rather than rebuild `member` to make that UNIQUE conditional (four tables
-- point at it; a rebuild against the live database is not worth it), the live
-- column is rewritten to a sentinel and the real sub is kept here. Google's
-- `sub` is a decimal string, so `removed:<id>` can never collide with one, and
-- `src/households.ts` refuses to accept a sub in that shape as input.
ALTER TABLE member ADD COLUMN removed_google_sub TEXT;
