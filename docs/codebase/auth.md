# Sign-in and who gets in

Google sign-in, the dev sign-in shortcut, the `requireMember` / `requireAdmin`
walls, and household isolation — read this before touching `src/auth.ts`,
`src/signin.ts`, `src/google.ts`, `src/session.ts`, `src/public-origin.ts` or
`src/members.ts`.

## Household isolation

Every route that touches household data is wrapped in `requireMember`
(`src/auth.ts`), and every query below it takes the member's `household_id` as a
parameter. There is no other way in. Another household's record is a 404, not a
403 — whether it exists is not this household's business.

## Sign-in

Google is the gate and there is no signup path. A Google account with no `member`
row is shown the wall and nothing is created.

Which means member rows are a bootstrap problem: a member is matched on Google's
`sub`, and the only way to learn somebody's `sub` is for them to try to sign in.
So the wall shows the person their own `sub`, for the household to insert by
hand:

    INSERT INTO member (household_id, google_sub, display_name, email)
    VALUES (1, '<sub from the wall>', 'Nimi', 'nimi@example.com');

The Google client id and secret are Worker secrets. Without them the app says
sign-in is not configured and lets nobody in. The redirect URI is derived from
the request's origin, so every origin used has to be registered in Google Cloud
Console — the live one and `http://127.0.0.1:8787` for local work.

A development server also offers **Kehityskirjautuminen** on `/signin`: a button
per existing member that issues a session directly. `POST /auth/dev-signin`
refuses with a 404 unless `isLocalOrigin` (`src/public-origin.ts`) says the
browser reached a loopback, private-network or tailnet address — the route says
no, it does not merely hide a button — and no env var or `wrangler secret put`
can turn it on for the deployment. It creates nobody: only a `member` row that
already exists gets a session, the same rule Google sign-in follows.
`tests/auth.spec.ts` checks that it refuses both production hostnames and sets
no cookie, and that an unknown member id is refused.

## Admin, and nothing more than admin

Issue #94 (merged as `837a8fe`, PR #102) is the one distinction between members
there is meant to be: a member either is an admin or is not. It exists for the
operations that are not every member's to run — the first is the recipe image
management screen (`/admin/recipe-images`), which can replace pictures in bulk.
It is deliberately not a role system, and turning it into one
is the failure mode to watch for.

`member.is_admin` (migration `migrations/0007_member_admin.sql`) is the only
thing that decides it. Nothing reads an email, a display name, a header, a
query string or the origin the request arrived on, and `tests/admin.spec.ts`
sends all of those to prove it. Existing members default to 0, so nobody gains
anything by the migration landing.

`requireAdmin` and `requireAdminScreen` (`src/auth.ts`) wrap `requireMember`
rather than replacing it, so an admin route is still a signed-in route and
still carries a household_id — household isolation is untouched. An ordinary
member is answered 404, the same answer another household's record gets:
whether an admin route exists is not their business. `GET /admin`
(`src/admin-screens.ts::adminScreen`) and `GET /api/admin/status`
(`src/admin-screens.ts::adminStatus`) are the two routes wired to it, and the
second exists so the JSON half of the gate is exercised rather than assumed.

Granting it is an operator action, like membership: `scripts/set-admin.sh
<google-sub> on|off`, which only ever updates a member who already exists (it
never inserts). There is no way to grant it from inside the app and there is
not meant to be.

### One panel, and one way to it (#106, proposed)

This pull request proposes that the admin panel be the only place an admin tool
is found, and the account button in the top bar be the only way to the panel.
`page()` therefore takes a viewer — `Member` satisfies it by shape — and every
signed-in screen passes the member it already holds. The sign-in screens pass
null. This is the shell-level presence #94 deliberately deferred, and the
week screen's own `Ylläpito` link goes away with it.

`accountMenu` in `src/html.ts` asks one question about the viewer: `isAdmin`.
Nothing else about a member reaches the shell, and the entry is still courtesy:
every route behind it refuses an ordinary member whether or not a link rendered.

`/admin` becomes a list of tools, one row each: recipe image management and the
AgentDeck bundle import. Adding the next admin tool means adding a row there,
not a link somewhere an ordinary member looks.

Seed member 3 is Koti's admin and member 1 stays ordinary, so the specs have
both sides.

`member.isAdmin` is threaded through every `members.ts` lookup via the shared
`MEMBER_COLUMNS` constant, so `findMemberById`, `findMemberByGoogleSub` and
`allMembers` stay in sync. The trap: adding a new member query and forgetting
`MEMBER_COLUMNS` would silently omit `is_admin` and make every member look
non-admin.

### Managing households and members (#127, proposed)

This pull request proposes the first admin tool that deliberately crosses a
household boundary: `Householdit` on `/admin`, which lists every household in
the database and opens one for editing — its name, its members, and adding,
editing or removing a member.

Until now membership was a hand-written INSERT against production, because the
only way to learn somebody's Google `sub` is to read it off the sign-in wall.
This proposes doing that job in the app, by the one member the app already
distinguishes.

The crossing is confined to `src/households.ts`, and that is the whole of the
containment. Nothing in that module takes a viewer's `household_id`, nothing
outside it reads another household, and every route that reaches it is wrapped
in `requireAdminScreen`. The household-scoped query pattern everywhere else is
unchanged — `tests/household-admin.spec.ts` ends by checking that member 1 still
cannot see household 2's ingredient.

Three things the proposal deliberately cannot do, all from #127:

- **It never touches `member.is_admin`.** The column is absent from every read
  and every write in `src/households.ts`, and the UPDATE names its three
  editable columns one by one, so a form field claiming `is_admin=1` is just
  more of the request. Granting admin stays `scripts/set-admin.sh`. A screen
  that could make more admins is the role system #94 refused to build.
- **There is no "move to another household".** A move is a removal and an
  addition, which leaves two visible actions instead of one silent reparenting.
- **There is no household delete.**

Removing a member is the operation with a real failure mode: `member.id` is what
`ingredient`, `recipe` (twice), `planned_batch` and `pantry_entry` record as
having created a row. `removeMember` counts those first and refuses in Finnish,
naming how many rows are in the way, rather than letting D1 answer with a
constraint error. It also refuses to remove the admin using the screen — an
admin who deletes their own row is locked out of the tool that would let them
back in.

A new table with a `REFERENCES member(id)` column has to be added to that count,
or the refusal turns back into a 500. `tests/household-admin.spec.ts` covers the
cupboard case specifically, because `pantry_entry.added_by` is the one that was
already nearly missed.

`src/auth.ts`, `src/router.ts`, `src/index.ts`, `src/env.ts` and any migration
are full-tier files (see `docs/codebase/testing.md`) — no focused spec covers
them, so a change here should run the whole browser suite, not just
`auth.spec.ts` / `admin.spec.ts`.
