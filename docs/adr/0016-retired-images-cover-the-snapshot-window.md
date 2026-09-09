# ADR-0016: Retired images cover the snapshot window

Status: proposed in #262; effective only after deployment and public verification
of the implementing release, with pre-upgrade cleanup drained and the first
supported post-rollout snapshot audited.

## Context

Database backups preserve `recipe.image_key`, not image bytes. Replacing a photo
and immediately deleting the previous object makes an otherwise valid historical
snapshot unrestorable. The read-only audit introduced by #271 detects this but
cannot recreate a person's original picture. The authorized live configuration
inspection recorded in #262 found no bucket lock protecting application deletes;
independent external copies remain unverified.

## Decision

Provide **30 days of historical-image availability** for schema-compatible snapshots
captured after rollout, while the source bucket remains intact. Retain a retired
image for **31 days after its last successful detachment** (30 days plus one restore
day). The clock is not upload age: yesterday's snapshot can reference a year-old
photo. Live references are never expired. This covers dish/part images through the
common storage path for user uploads, URL imports and supplied generated images.

`src/recipe-image-lifecycle.ts` is the authoritative home for this lifecycle
contract: conditional image replacement/removal, retirement receipt renewal,
uncertain-commit retention, the 30-day recovery plus one-day restore margin,
whole-tree image retirement statements, and delayed R2 cleanup. HTTP/read routes
remain in `src/recipe-images.ts`; recipe deletion remains responsible for deciding
whether a tree may be deleted and delegates only its image-retirement statement.

Reuse `recipe_image_cleanup` and the existing cron. In one D1 transaction, enqueue
the image currently matching the owner/expected-key predicate, then perform the
matching conditional update. Whole-tree deletion uses the same retirement renewal.
A failed statement rolls back both. A stale request changes neither the winning
picture nor an old receipt. Re-detachment after restore renews `queued_at` and clears
`last_attempt_at`; an old receipt cannot shorten a new window. No schema change is
needed because backup/restore already preserve these fields.

Cleanup selects at most ten expired, unreferenced keys, rechecks age/live references
and the receipt's timestamp before deletion, and acknowledges only that generation.
Failure moves the attempt behind older work and remains retryable. Malformed dates
fail closed. Application writes and maintenance must be quiesced during restore;
this is not a distributed lock covering concurrent operator SQL or bucket changes.

Only a confirmed losing upload is immediately disposable. A database transport
error can follow a successful commit: preserve its uploaded bytes and attempt a
retirement receipt instead of deleting a potentially published image. If D1 cannot
record that either, emit a sanitized diagnostic and leave a safe stray object.

## Consequences and boundaries

The user-visible delete/remove operation remains immediate; backend image deletion
is delayed and storage includes current plus unexpired retired versions. Cleanup
failures and receipts lost by restoring an older snapshot can leave additional
bytes. Reconciliation must respect all supported snapshots, not just upload age.
No second scheduler, framework, archive store or bucket configuration is added.

The one-day margin supports a timely restore; it does not authorize racing cleanup.
Follow `docs/backup-restore.md`: quiesce, audit bytes, restore compatible rows, audit
again, and only then resume. Pre-rollout snapshots and previously missing bytes are
not retrospectively protected. This policy does not relax schema compatibility or
prove historical identity without retained original-byte/digest evidence.

**Full bucket-loss recovery remains outside this same-bucket policy.** Verify any
existing independent byte archive before adding one. A full-loss promise requires
its own paired snapshot/byte manifests, retention decision and recovery evidence;
no database key or additional copy in the same lost bucket can establish it.

## Verification

`dev/check-image-retention.ts` calls the lifecycle module's actual upload, remove and
cleanup operations together with guarded tree deletion, restore and backup-image
audits against migrated disposable SQLite and a byte-preserving object store. It
verifies original parent/part digests within the window, both provenances,
safety-margin/expiry boundaries, reset after restore, failed CAS/transaction
rollback, lost responses, stale cleanup acknowledgements, invalid timestamps,
cross-household live references and explicit missing bytes. The existing deletion
fault tests still exercise R2 and acknowledgement failures and bounded retries,
after deliberately aging the test receipts past retention. CI retains the full
application and browser gates. No destructive production restore is part of
implementation verification.
