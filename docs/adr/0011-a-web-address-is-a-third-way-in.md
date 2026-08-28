# ADR-0011: A web address is a third way in, and it reverses decision #4

## Status

Proposed by issue #192. This change **reverses part of wayfinder decision #4**
("Where recipes come from", closed), which ruled URL import out. The reasoning
recorded in `docs/codebase/intake.md` under "Why pasted text, not a URL
importer" is superseded by this document; the rest of #4 — the model does the
structuring, raw text is kept forever, images are discarded — is untouched and
still holds.

Decision #4 and this issue were both raised by the same person. This is a
change of mind about a trade-off, not a disagreement between two requests.

## The decision this change introduces

**A recipe may be added by giving its web address.** The app fetches the page,
reduces it to text, and hands that text to the same model call, the same review
screen and the same save that pasted text goes through. `IntakeSource` gains a
`linked` arm; nothing downstream of the model knows the difference.

**Structured data first, page text second.** `src/recipe-fetch.ts` looks for a
`schema.org/Recipe` node in the page's JSON-LD and renders it as the plain
Finnish a person would have pasted. Where a page has none, the visible text is
stripped out and used instead. Neither path is parsed into a recipe here — that
is still the model's job, for the reason #4 gave: there is no parser for Finnish
ingredient lines.

**The fetch is its own route and spends nothing.** `POST /api/intake/fetch`
returns text; the ordinary streaming route then structures it. So the member
sees what the page gave up, in the paste box, before a paid call happens — and
can fix it.

**The address is kept on the recipe.** `recipe.source_url`, and
`recipe.source_route` gains `linked` so how a recipe arrived is still recorded
truthfully.

**The page is never trusted.** Only a public HTTP address by hostname is
fetched; every redirect hop is re-checked the same way; the body is capped as it
arrives; and a failure is reported to the browser as one of five words, never as
the page's own prose.

## Why now, when #4 said no

#4's argument was that pasting already covers every site a scraper reaches *and*
the ones it cannot, so a URL importer is a second route to maintain for no new
capability. That was true about capability and wrong about effort. Pasting a
recipe on a phone means opening the page, selecting text that is interleaved
with adverts and a life story, and getting the whole selection — which is the
step where the import actually gets abandoned. An address is one paste of one
short string.

#2 ("What the web actually gives us for recipe import") had already found that
most Finnish recipe sites publish clean `schema.org/Recipe` JSON-LD, with no
Finnish-specific code needed. That finding is what makes this cheap: the
importer is a fetch, a JSON walk and a fallback, not a per-site scraper.

The robots.txt question #4 raised is answered narrowly rather than dismissed:
this fetches one page a member has already chosen to read, at the moment they
ask for it, identifying itself honestly in its `User-Agent`. It is not a
crawler, it follows no links, and it stores no copy of the page beyond the
recipe text the household would have pasted by hand anyway.

## What this does not change

- **Pasting stays first.** It is still the route that covers everything, still
  the one the screen leads with, and a linked import that came back half-empty
  simply becomes a paste the member finishes by hand.
- **The model still structures.** No ingredient-line parsing happens in
  `recipe-fetch.ts`; JSON-LD's `recipeIngredient` strings are handed over as
  sentences, exactly as a page's own text would be.
- **Nothing new is stored.** Text and an address. `recipe-fetch.ts` writes
  nothing to D1 and touches no bucket.
- **Household isolation.** The fetch route is behind `requireMember` like every
  other route that touches household data.

## What was considered and rejected

- **Fetching inside the streaming route.** Fewer round trips, but the member
  would never see the extracted text before the model was paid for it, and a
  page that gave up nothing would have to be reported by unwinding a stream that
  had already started.
- **Importing the page's picture.** The issue asks for it "if available and use
  is permitted", and that clause is the problem: a recipe photograph is somebody
  else's work, and #4 already settled that this app stores text and discards
  images. A household can still upload or generate a picture as before. This is
  the one thing in #192's wish list this change deliberately leaves out.
- **Trusting the platform's redirect following.** A public address that redirects
  to a private one is exactly the case the address guard exists for, so hops are
  followed by hand and each one is re-checked.
- **Letting the server write the Finnish for a fetch failure.** The island owns
  every word a member reads. The server names one of five cases; the island says
  what that means.
- **A per-site scraper for the Finnish recipe sites.** #2 found it unnecessary,
  and it is the maintenance burden #4 was right to refuse.
