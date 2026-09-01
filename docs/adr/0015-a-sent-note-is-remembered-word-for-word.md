# ADR-0015: A note this app sent is remembered word for word

## Status

Proposed by issue #244. It adds to
[ADR-0014](0014-a-packet-count-is-the-s-list-rows-quantity.md) rather than
changing it: the free-text fallback ADR-0014 kept is the thing this decision is
about, and nothing about packet counts moves.

## The problem

An ingredient with no product chosen goes to the S-ostoslista as free text —
`juusto — 6 dl`. Choose a product for it later and the next send adds the EAN
product row, and until this change left the old text sitting beside it. In the
shop that reads as two different things to buy: `juusto — 6 dl` and
`Kotimaista juustoraaste 250 g`.

`SOstoslistaClient.remove()` could already delete by key. Nothing called it.
The hard part was never the deletion — it was naming the row to delete.

Two facts make that hard. The S-list deletes a text row by its **exact** words,
and those words contain the amount. The amount comes from whichever cookings
happen to be selected, so last week's `juusto — 4 dl` cannot be spelled by
this week's list at all. Recomputing the key at send time therefore cleans up
only the case where the amount happens not to have changed — which is the case
that was never really broken.

## The decision

**The exact note is written down when it is sent, and that recorded string is
the delete key.** `migrations/0023_s_ostoslista_sent_note.sql` adds one small
table, `s_ostoslista_sent_note`, holding one row per household per shopping
row: the words that went out, and when.

The alternatives, and why not:

- **Recompute the key from today's list.** Cheap, no new state, and leaves
  behind exactly the rubbish this issue is about the moment an amount changes.
- **Read `GET /items` and delete every text row starting with the ingredient's
  name.** Finds the older amount too, but cannot meet the criterion that a send
  never deletes a row the household did not get from this app. A `juusto`
  somebody typed on their phone is, from the outside, indistinguishable. It
  also leans on the note's own layout — this app's formatting, not a guarantee
  the S-list makes.
- **Put a visible marker in every fallback note and match on that.** No
  migration, but it changes what the household reads on the phone, and it can
  never clean up a note sent before the marker existed.

Having sent it is what makes a row this app's to remove. That is a fact about
the past, so it has to be stored; it cannot be derived from the present.

## What follows from it

- **Add first, delete second, forget third.** A send that dies in the middle
  leaves the note still on record, so the next attempt finishes the job instead
  of stranding the text row forever. Deleting first would risk a list with
  neither row on it. This is the same retry-safety the rest of the send already
  promises.
- **Resending the same words deletes nothing.** The add is keyed, so the row is
  simply confirmed; deleting the recorded note afterwards would take the row
  that was just added straight back off the list.
- **A note that is already gone is success, not an outage.** The household may
  have cleared it on the phone between the two sends. The service says so with
  a 404, and `shopping-screens.ts::dropNote` treats that as the wanted state.
  Any other error stops the send and keeps the note on record.
- **The key is the shopping row, not the ingredient.** A dish pinned to its own
  product is its own row (`12:r7` beside `12`, ADR-0008), and each may have
  sent its own note.
- **It is a new table, so it goes through the manifest lockstep** in
  `docs/codebase/data-model.md`. It is worth backing up despite being small: it
  is the only record of which rows out on the phone's list are this app's to
  delete, and losing it strands every one of them.

## What this does not cover

The issue names two neighbours with the same root cause — nothing deletes
anything — and both are left alone here:

- Swapping one product for another leaves the old EAN row on the list.
- Removing a packet size, or putting the ingredient in the cupboard, after a
  send leaves its row on the list.

Both are about a **product** row rather than a note, so neither needs the
recorded-words trick this decision exists for: a product's key is its EAN, and
an EAN does not change with the week. They are a different card.
