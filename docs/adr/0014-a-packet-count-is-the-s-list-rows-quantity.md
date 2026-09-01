# ADR-0014: A packet count is the S-list row's quantity, not a note beside it

## Status

Proposed by issue #240. It supersedes the last bullet of
[ADR-0008](0008-an-ingredient-knows-several-products.md), which is the only part
of that decision this touches — everything else about several products per
ingredient and a recipe insisting on one stands.

## The problem

#161 worked out how many packets a week's cooking needs, and then had to say
that number to the phone. The private service's `POST /items` is keyed by EAN
and holds one row per key, so adding the same barcode twice does not put two of
it on the list. #161 read that as the integration having no way to carry a
count, and sent the second packet as a written line beside the product —
`Kotimaista nauta-sikajauheliha 400 g × 2`.

What #240 reported is what that costs. Two dishes each wanting 400 g of
jauhelihaa add up to 800 g, the packet planner turns that into two 400 g
packets, and the phone ends up holding one packet of the product plus a piece of
text. A shopper reading it sees a note where they had chosen a product, and
nothing on the list says how much to buy. The mapping the household took the
trouble to make is the thing that got lost.

## The decision

**The count is the row's quantity.** A product row on the S-ostoslista carries
`quantity` and `quantityUnit`, the private service accepts `quantity` on both
`POST /items` and `PATCH /items/:id`, and its background sync pushes the number
through `batchUpdateShoppingListItem`. #161's caution was the right instinct
about an API nobody had read; the field is there, and this change reads it
rather than assuming either way.

`src/shopping-screens.ts::sendShoppingListForm` therefore sends one add per
product carrying its packet count, and no `× n` note. The free-text fallback
stays for the one case it is actually for: an ingredient with no product chosen
at all, which goes as its name and its Ruokalista amount.

## What follows from it

- **The count goes out twice, on the add and on the edit that follows it.** The
  keyed add hands back a row the list already had — which, after the household
  bought that product last week, is a row holding last week's count. The POST's
  own quantity is ignored exactly when it matters, so the patch that already
  clears `collected` for #236 states the quantity again. This is the same
  reasoning #236 used for the flag: say it outright rather than trust what came
  back.
- **Even one packet is said.** A row for a single packet sends `quantity: 1`
  rather than nothing, because saying nothing would leave a row from an earlier
  trip holding that trip's larger number.
- **Counts are added up per product before anything is sent.** One row's packet
  count is not the whole story: a dish pinned to its own product sits beside the
  generic pile as a separate row (ADR-0008), and two ingredients can be bought
  as the same packet. The packet planner only ever sees one row, so the send
  totals them per EAN — otherwise a keyed row ends up holding whichever of them
  went last instead of the trip's need.
- **A count this app could not have worked out is refused, not rounded.**
  `src/s-ostoslista.ts` rejects a quantity that is not a whole number of at
  least one. Nought or a half is this app's arithmetic having gone wrong, and
  quietly sending one instead would tell the shop a number nobody worked out.
