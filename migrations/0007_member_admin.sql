-- One explicit marker, not a role system: a member either is an admin or is not.
--
-- The default is 0, so every member that already exists stays ordinary until an
-- operator deliberately marks them. Admin is never inferred from an email, a
-- display name, the origin a request arrived on, or anything the client says —
-- this column is the only thing that decides it.
ALTER TABLE member ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
