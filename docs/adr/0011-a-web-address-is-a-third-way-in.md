# ADR-0011: A web address is a third way in, and it reverses decision #4

## Status

Proposed by issue #192. **Amended by issue #205**, which reverses one of the
rejections below: a picture found on the page now comes in with the recipe. See
"Amendment: the page's picture" at the foot of this document. Everything else
here stands.

This change **reverses part of wayfinder decision #4**
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

**A linked import is a background job like the other two.** The address goes to
`POST /api/intake/imports`, and the page is read by the queue consumer rather
than by the request that started it. That follows #186 rather than working
around it: fetching in the request would hold that request open for as long as
somebody else's site takes to answer, and a member who navigated away would
lose the import — the two things #186 moved imports off the request to prevent.
The text the consumer reads is written back onto the job before the model runs,
so a model failure retries the structuring rather than the whole read, and a
fetch refusal is a failed job on the import list with Finnish wording, next to
every other background failure.

**The address is kept on the recipe.** `recipe.source_url`, and
`recipe.source_route` gains `linked` so how a recipe arrived is still recorded
truthfully.

**The page is never trusted.** Only a public HTTP address by hostname is
fetched; every redirect hop is re-checked the same way; the body is capped as it
arrives; and a failure is named internally as one of five words, turned into
Finnish in one place, and never reported as the page's own prose.

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
  **Reversed by #205 — see the amendment below.**
- **Trusting the platform's redirect following.** A public address that redirects
  to a private one is exactly the case the address guard exists for, so hops are
  followed by hand and each one is re-checked.
- **Letting the server write the Finnish for a fetch failure.** The island owns
  every word a member reads. The server names one of five cases; the island says
  what that means.
- **A per-site scraper for the Finnish recipe sites.** #2 found it unnecessary,
  and it is the maintenance burden #4 was right to refuse.

## Amendment: the page's picture (#205)

Issue #205, raised by the same person as #192, changes this one decision:
**when a linked import finds the dish's own photograph, it comes in with the
recipe.** The reasoning above was about somebody else's work and about #4's
"stores text, discards images". What #205 weighs against that is the household
in front of the screen: they have imported the recipe they were reading, and
asking them to go back, save the picture and upload it by hand — or to pay for
a generated one that is not the dish — is the same abandoned-import friction
that made a URL importer worth building in the first place.

What this pull request introduces:

- **The page names the picture; it is never guessed.** `schema.org/Recipe`'s
  own `image` first. `og:image` only as a fallback, and only on a page that
  carried a `Recipe` node at all — that condition is the whole guard, because
  `og:image` on a recipe page is the dish and on any other page is a masthead.
  A page with no structured recipe gets no picture.
- **The bytes are copied, not linked.** `recipe.image_key`, in this household's
  own prefix, through the same `storeRecipeImage` an upload goes through and
  the same signature, byte and pixel checks. Nothing depends on the site
  keeping its URL stable or allowing hotlinks. #4's "images are discarded" is
  what changes; "the model still structures" and "nothing is trusted" do not.
- **Nothing about the picture can fail an import.** It is fetched after the
  recipe text is already written back onto the job, every failure is a log line,
  and a candidate that turns out to be an error page, too many pixels or not an
  image at all is simply the next candidate's turn.
- **The address guard is not weakened to fetch it.** Every picture address goes
  through `normaliseRecipeUrl` and the same redirect-by-hand loop, so a
  photograph "hosted" on a private name is refused exactly as a page would be.
- **The member sees it before it is saved.** It is shown on *Tarkista resepti*
  with a tick that is on by default; unticking it saves the recipe without one.

What stays as written above: pasting is still the route that covers
everything, the model still does the structuring, `recipe-fetch.ts` still parses
no ingredient lines, and every route is still behind `requireMember`.
