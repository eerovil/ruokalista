-- Park a removed member outside Google's id space, not inside it (#127).
--
-- `migrations/0009_member_removed.sql` frees a removed member's UNIQUE
-- `google_sub` by rewriting the live column, and parked the row on
-- `removed:<id>` — reasoning that a Google `sub` is a decimal string and so
-- could never look like that.
--
-- Google promises no such thing. Its OpenID Connect contract says a `sub` is a
-- case-sensitive ASCII string of at most 255 characters, and nothing more, so
-- `removed:2` is a legal account id. Reserving that shape shut a real person
-- holding it out of the admin screen, and left them a parked row to collide
-- with on the UNIQUE column — a removal failing at a constraint, over an id
-- nobody in this app chose.
--
-- So the tombstone leaves that contract instead of carving a corner out of it:
-- U+2014 EM DASH, written here as `char(8212)`, followed by the member id. It
-- is not ASCII, so it is not a `sub`. `src/google.ts::isGoogleSub` states the
-- contract in one place, and both sign-in and the admin form are held to it, so
-- nothing either of them accepts can equal a tombstone.
--
-- 0009 has already shipped, so any row parked on the old sentinel is moved
-- here. `removed_at IS NOT NULL` is part of the match on purpose: a *live*
-- member whose real Google sub happens to read `removed:<their own id>` is
-- somebody's actual account, and this must not touch it.
UPDATE member
   SET google_sub = char(8212) || 'removed:' || id
 WHERE removed_at IS NOT NULL
   AND google_sub = 'removed:' || id;
