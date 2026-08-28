-- An admin can reserve one household membership with only an email (#187).
--
-- The permanent member row still belongs to Google's stable `sub`, never to an
-- email address. This table is the short bridge: its row authorizes the holder
-- of the matching verified Google email to create that real member on first
-- sign-in, then the row is consumed.
--
-- Emails are stored trimmed and lower-cased by `src/households.ts`. NOCASE on
-- the UNIQUE constraint makes the database keep the same promise if a caller
-- ever forgets that normalization.
CREATE TABLE member_invitation (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);

CREATE INDEX member_invitation_by_household
  ON member_invitation(household_id);

-- Existing member edits and invitation claims must uphold the same promise.
-- Removed rows deliberately release their address for a remove-then-add move.
CREATE UNIQUE INDEX active_member_by_normalized_email
  ON member(lower(trim(email)))
  WHERE removed_at IS NULL AND email IS NOT NULL;
