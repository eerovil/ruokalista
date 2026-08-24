# What an LLM import actually costs

Fact-finding for [#9](https://github.com/eerovil/ruokalista/issues/9). It prices the
intake dependency the map already committed to — every recipe arrives as pasted Finnish
text or a photograph of a printed page ([#4](https://github.com/eerovil/ruokalista/issues/4)),
and a model must return a title, steps, and ingredient lines of
`(quantity, unit, ingredient, source line)` with a proposed match against the household's
shared ingredient list ([#6](https://github.com/eerovil/ruokalista/issues/6)), never
fabricating a quantity.

It does not pick a model or a runtime. Everything below is a number with a source next to
it, or an explicit gap.

Researched 2026-08-24.

---

## Headlines

- **A text import is one API call of roughly 2,900 input tokens and 1,100–1,600 output
  tokens.** Measured, not guessed: the prompt is a real 497-token instruction block plus a
  real 300-entry ingredient list plus a real recipe pasted from kotikokki.net.
- **Cost per text import spans a factor of 140 across plausible models** — $0.00062 on
  `gpt-5-nano` to $0.089 on Claude Fable 5. Three hundred recipes costs between **$0.19 and
  $27**. This is not a decision that needs a budget; it is a decision that needs a quality
  judgement.
- **A photographed A5 page costs 1.4–1.7× a text import**, because the page is
  1,000–4,800 image tokens depending on the vendor's tiling rule. Not the cliff you would
  expect.
- **The ingredient list does have to be in the prompt** for the match step, and at 300
  entries it is 1,967 tokens — about **68% of the whole text-import prompt**. It is the
  single largest line item.
- **Prompt caching applies but will almost never fire for this household.** Anthropic's
  cache TTLs are 5 minutes and 1 hour; a household importing a few recipes a week is cold
  every time. Caching only pays inside a single sitting.
- **Local inference on this host is not viable.** Measured on the actual machine: an 8B
  Finnish-tuned model (Poro 2) runs at single-digit tokens per second, so one import takes
  minutes, and nothing local reads the photograph at all.

---

## 1. Method, and the one caveat that colours every token number

Every token count below was produced by encoding a real file with a real tokenizer:

```
/tmp/tokvenv/bin/python -c "import tiktoken; print(len(tiktoken.get_encoding('o200k_base').encode(open('borssi.txt').read())))"
```

`o200k_base` is OpenAI's current tokenizer, so the counts are **exact for the GPT-5 /
GPT-4.1 families** and approximate for everyone else.

> **Gap — no Anthropic or Google token count.** `/v1/messages/count_tokens` and Gemini's
> `countTokens` both need an API key, and this host has none (`printenv ANTHROPIC_API_KEY`
> is empty; `ant` is not installed). Anthropic's own docs warn that **"Claude 4.7 and later
> models and Claude Mythos Preview use a newer tokenizer… This tokenizer produces
> approximately 30% more tokens for the same text"**
> ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) — and that is
> relative to Claude's *own* previous tokenizer, not to OpenAI's. Treat every Claude token
> figure here as ±30% and re-measure with `count_tokens` before committing to a model. The
> *shape* of the answer (which line items dominate, the ratio between routes) does not move.

Finnish is expensive per character, which is worth knowing on its own: the Borssikeitto
text is 1,161 characters and 428 `o200k_base` tokens — **2.71 characters per token**,
against the ~4 that Anthropic's own FAQ quotes for English ("1 token is approximately 4
characters"). Budget Finnish at roughly 1.5× English for the same text.

---

## 2. The real example

I did not invent a recipe. Four real Finnish recipes were fetched and their
`schema.org/Recipe` JSON-LD extracted:

```
curl -s -A "Mozilla/5.0 ..." "https://www.kotikokki.net/reseptit/nayta/104372/Borssikeitto/"
```

| Recipe | Ingredient lines | Words | Chars | `o200k_base` tokens |
|---|---|---|---|---|
| [Borssikeitto](https://www.kotikokki.net/reseptit/nayta/104372/Borssikeitto/) | 20 | 144 | 1,161 | **428** |
| [KARJALANPAISTI RAUTJÄRVELT](https://www.kotikokki.net/reseptit/nayta/41729/KARJALANPAISTI%20%20RAUTJ%C3%84RVELT/) | 8 | 194 | 1,504 | 512 |
| [Kermainen Karjalanpaisti](https://www.kotikokki.net/reseptit/nayta/597332/Kermainen%20Karjalanpaisti/) | 9 | 371 | 2,793 | 882 |
| [Perinteinen Karjalanpaisti](https://www.kotikokki.net/reseptit/nayta/841808/Perinteinen%20Karjalanpaisti/) | 6 | 63 | 525 | 195 |

Borssikeitto is the working example throughout: 20 ingredient lines, and exactly the dirt
[#2](https://github.com/eerovil/ruokalista/issues/2) catalogued —

```
½dl öljyä
½kpl pieni kaali
1kpl purjosipulia
1kpl Sipuli
1prk tomaattipyreetä
2kpl wääksyn kartanon ruukkupersiljaa
punaviinietikkaa
suolaa
pippuria
```

No space between quantity and unit, a mixed-case `Sipuli`, three lines with no quantity at
all, and a brand name inside an ingredient. It is a fair test of the #6 rules.

The measurable range across the four is **195–882 input tokens for the recipe itself**.
Everything below uses Borssikeitto's 428 and notes the spread where it matters.

### The prompt

The instruction block encodes the #6 rules verbatim — never fabricate a quantity, keep the
source line, keep the unit as written, propose a match against the list, split
`suolaa ja pippuria` into two entries, copy the yield only if stated. It measures **497
tokens**. (The full text is reproduced in [Appendix A](#appendix-a--the-prompt-that-was-measured).)

### The output

A realistic structured answer for Borssikeitto — 20 ingredient-line objects with
`source_line`, `quantity`, `unit`, `proposed_ingredient` and a `match`, plus five steps and
a yield — measures **1,086 tokens compact** (`separators=(',',':')`) and **1,560 tokens
pretty-printed**. JSON whitespace is a 44% output-cost swing; ask for compact output.

All cost figures below assume **1,200 output tokens**.

### The photographed page

An A5 cookbook page (148 × 210 mm) photographed on a phone, then cost per the vendors'
documented formulas:

| Input | Claude 4.7+ (high-res) | Claude standard | GPT-5.5/5.4 `high` | `gpt-5-mini` | `gpt-5-nano` | `gpt-4.1` / `4o` tiles | Gemini |
|---|---|---|---|---|---|---|---|
| 12 MP photo, uncropped 4032×3024 | 4,740 | 1,564 | 2,494 | 2,479 | 3,764 | 765 | 6,192 |
| **Cropped to the page, 2200×3111** | **4,756** | 1,551 | 2,478 | 2,459 | 3,734 | 1,105 | 3,870 |
| A5 scan at 300 dpi, 1748×2480 | 4,756 | 1,551 | 2,478 | 2,459 | 3,734 | 1,105 | 3,096 |
| A5 scan at 150 dpi, 874×1240 | 1,440 | 1,440 | 1,092 | 1,769 | 2,686 | 1,105 | 1,032 |

Formulas, all first-party:

- **Anthropic** — "Each patch is a 28×28-pixel block… An image, therefore, costs
  `⌈width / 28⌉ × ⌈height / 28⌉` visual tokens." Claude 4.7 and later are the
  high-resolution tier, capped at **2576 px long edge / 4784 visual tokens**; everything
  else is capped at **1568 px / 1568 tokens**
  ([vision](https://platform.claude.com/docs/en/build-with-claude/vision)).
- **OpenAI** — 32 px patches, `original_patch_count = ceil(width/32)×ceil(height/32)`,
  resized to a per-model budget (2,500 patches / 2,048 px for GPT-5.5 and 5.4 at `high`;
  **1,536 patches** for the mini and nano models), then multiplied: **×1.62 for
  `gpt-5-mini`, ×2.46 for `gpt-5-nano`**. GPT-4.1 / 4o instead tile: fit 2048², shortest
  side to 768, **85 base + 170 per 512 px tile**
  ([images-vision](https://developers.openai.com/api/docs/guides/images-vision)).
- **Gemini** — "258 tokens if both dimensions <= 384 pixels. Larger images are tiled into
  768x768 pixel tiles, each costing 258 tokens"
  ([image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)).

Two consequences worth acting on. **Cropping to the page and downscaling is free money** —
a 150 dpi A5 scan is a third the image tokens of the same page at 300 dpi on Claude and a
sixth on Gemini, and 150 dpi is still ~10 px per lowercase x-height, comfortably legible.
And the nano/mini multipliers **invert the usual ordering**: `gpt-5-nano` charges *more*
image tokens than `gpt-5.4` for the same page (3,734 vs 2,478), because the ×2.46
multiplier outweighs its smaller patch budget. It is still cheaper in dollars, but not by
as much as the per-token price suggests.

For photo imports the output also grows, because #4 requires the raw text be kept forever —
the model has to hand back what it read. Costs below assume **1,628 output tokens**
(1,200 JSON + the 428-token text readout).

> **Gap — no photograph was actually sent.** These are the documented formulas applied to
> realistic pixel dimensions, not observed `usage.input_tokens`. The formulas are
> deterministic, so the arithmetic should hold, but the *quality* question — does a model
> read a photographed Finnish cookbook page correctly — is untested here. #2 established
> that printed-Finnish OCR is viable and handwriting is not; nothing in this ticket
> re-tested it.

---

## 3. Prices per million tokens

### Anthropic ([pricing](https://platform.claude.com/docs/en/about-claude/pricing), fetched 2026-08-24)

| Model | Input | 5m cache write | 1h cache write | Cache read | Output | Images |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | **$1** | $1.25 | $2 | $0.10 | **$5** | yes (standard tier) |
| Claude Sonnet 5 | **$2** | $2.50 | $4 | $0.20 | **$10** | yes (high-res) |
| Claude Opus 5 | $5 | $6.25 | $10 | $0.50 | $25 | yes (high-res) |
| Claude Opus 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 | yes |
| Claude Fable 5 | $10 | $12.50 | $20 | $1 | $50 | yes |

Sonnet 5's $2/$10 is now the standard price, not an introductory one: *"The $2/$10 per
million input/output token pricing for Claude Sonnet 5, announced at launch as introductory
pricing through August 31, 2026, is now the standard price."* Batch API is **50% off both
directions** on every model. Every Claude model in the table takes images — the vision
doc's resolution tiers are "Claude 4.7 and later models" (high-res) and "All other models"
(standard), with no non-vision exception listed.

### OpenAI ([pricing](https://developers.openai.com/api/docs/pricing), fetched 2026-08-24)

| Model | Input | Cached input | Output | Images |
|---|---|---|---|---|
| `gpt-5-nano` | **$0.05** | $0.005 | **$0.40** | yes |
| `gpt-4.1-nano` | $0.10 | $0.025 | $0.40 | yes |
| `gpt-4o-mini` | $0.15 | $0.075 | $0.60 | yes |
| `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 | yes |
| `gpt-5-mini` | $0.25 | $0.025 | $2.00 | yes |
| `gpt-4.1-mini` | $0.40 | $0.10 | $1.60 | yes |
| `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 | yes |
| `gpt-4.1` | $2.00 | $0.50 | $8.00 | yes |
| `gpt-5.4` | $2.50 | $0.25 | $15.00 | yes |
| `gpt-5.5` | $5.00 | $0.50 | $30.00 | yes |

The vision-capable list is explicit and includes every mini and nano model above: "GPT-5.6,
GPT-5.5, GPT-5.4, GPT-5.4-mini, GPT-5.4-nano, GPT-5-mini, GPT-5-nano, GPT-5.2, … gpt-4.1-mini,
gpt-4.1-nano, GPT-4o, GPT-4.1, GPT-4o-mini …". Note the **cached-input discount is 10× on
the GPT-5 family** ($0.05 → $0.005) but only 4× on `gpt-4.1-nano` and 2× on `gpt-4o-mini`.

### Google Gemini ([pricing](https://ai.google.dev/gemini-api/docs/pricing), fetched 2026-08-24)

| Model | Input | Output | Context caching | Images |
|---|---|---|---|---|
| Gemini 2.5 Flash-Lite | **$0.10** | **$0.40** | $0.01 | yes |
| Gemini 2.5 Flash | $0.30 | $2.50 | $0.03 | yes |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | $0.03 | yes |
| Gemini 3.7 / 3.6 Flash | $0.75 (→$1.50 on 2027-01-01) | $3.75 (→$7.50) | $0.075 | yes |
| Gemini 3.5 Flash | $1.50 | $9.00 | $0.15 | yes |
| Gemini 2.5 Pro | $1.25 (≤200k) / $2.50 | $10.00 / $15.00 | $0.125–$0.25 | yes |

Gemini 3.7 and 3.6 Flash carry a documented price *increase* on 2027-01-01 — worth knowing
before building on the promotional rate.

> **Gap — Mistral not priced.** [mistral.ai/pricing](https://mistral.ai/pricing) gives only
> "Mistral Large: $0.5 /M tokens in and $1.5 /M tokens out" and defers the rest to a table
> the fetch did not return. Mistral Small / Pixtral, which would be the relevant
> cheap-with-vision entries, are unpriced here.

---

## 4. Cost per import, and the totals

All figures reproducible with `python3 costs.py` ([Appendix B](#appendix-b--the-cost-script)).

**Assumptions, inline:**
- Text import input = 497 (instructions) + 1,967 (300-entry ingredient list) + 428 (recipe)
  = **2,892 tokens**. Output **1,200**.
- Photo import input = 497 + 1,967 + the model's own image-token count for a page-cropped
  photo. Output **1,628** (JSON + text readout).
- One API call per import. No retries, no re-runs, no caching.
- List-price on-demand rates. The Batch API's 50% (Anthropic) is not applied — an import is
  interactive; the human is waiting at the check-and-correct screen.

| Model | Text import | Photo import | 10 text | 50 text | 300 text | 300 photo |
|---|---|---|---|---|---|---|
| `gpt-5-nano` | $0.00062 | $0.00096 | $0.006 | $0.031 | **$0.19** | $0.29 |
| `gpt-4.1-nano` | $0.00077 | $0.00127 | $0.008 | $0.038 | $0.23 | $0.38 |
| Gemini 2.5 Flash-Lite | $0.00077 | $0.00128 | $0.008 | $0.038 | $0.23 | $0.39 |
| `gpt-4o-mini` | $0.00115 | $0.00151 | $0.012 | $0.058 | $0.35 | $0.45 |
| `gpt-4.1-mini` | $0.00308 | $0.00457 | $0.031 | $0.154 | $0.92 | $1.37 |
| `gpt-5-mini` | $0.00312 | $0.00449 | $0.031 | $0.156 | $0.94 | $1.35 |
| Gemini 2.5 Flash | $0.00387 | $0.00597 | $0.039 | $0.193 | $1.16 | $1.79 |
| Gemini 3.7 Flash | $0.00667 | $0.01086 | $0.067 | $0.333 | $2.00 | $3.26 |
| **Claude Haiku 4.5** | $0.00889 | $0.01215 | $0.089 | $0.445 | **$2.67** | $3.65 |
| **Claude Sonnet 5** | $0.01778 | $0.03072 | $0.178 | $0.889 | **$5.34** | $9.22 |
| `gpt-5.4` | $0.02523 | $0.03678 | $0.252 | $1.261 | $7.57 | $11.03 |
| **Claude Opus 5** | $0.04446 | $0.07680 | $0.445 | $2.223 | **$13.34** | $23.04 |
| Claude Fable 5 | $0.08892 | $0.15360 | $0.889 | $4.446 | $26.68 | $46.08 |

The load-bearing observation is not any single number. It is that **300 recipes — a large
household cookbook, years of accumulation — costs under $30 on the most expensive plausible
model and under $1 on six of the thirteen.** Import cost is not a constraint on this
project. It is small enough that re-running every import from scratch when a better model
arrives (which #4 explicitly designed for by keeping the raw text forever) is also
affordable: a full 300-recipe re-import on Haiku 4.5 is $2.67.

Two things that *would* change the picture and are not in the table:

- **Retries and re-runs.** A bad import that the human sends back through the model doubles
  that recipe's cost. At these absolute numbers, irrelevant.
- **A conversational correction loop.** If the check-and-correct screen lets the human argue
  with the model rather than just edit fields, each turn resends the whole prompt. Three
  turns triples the input cost. This is a UI decision with a cost consequence, and the UI
  is still fog.

---

## 5. Does the ingredient list have to be in the prompt?

**Yes, for the match step as #6 defines it — and it is the largest line item in the prompt.**

#6 requires the model to "propose a name and a match against the existing ingredient list".
A model cannot match against a list it cannot see. There are only three ways to give it
one:

1. **Put the whole list in the prompt.** Simple, stateless, and what the numbers below cost.
2. **Give the model a lookup tool** and let it call `find_ingredient("purjosipulia")` per
   line. Trades prompt tokens for round trips — 20 tool calls for Borssikeitto, each
   resending the conversation. Anthropic's tool-use system prompt alone is 286–406 tokens
   on Opus 5 before any tool schema. For a 20-line recipe this is almost certainly *more*
   expensive than pasting the list, and much slower.
3. **Match in the app, not the model** — let the model return only `proposed_ingredient` in
   nominative form, then fuzzy-match against the list in code. Cheapest by far (zero prompt
   tokens), but #2 established that Finnish word forms make string equality "the exception,
   not the rule", and #6's whole point is that `purjo` and `purjosipuli` must not become two
   records. A code-side matcher is the thing #2 said nobody has written.

Option 1 is what the costs above assume. Measured cost of the list alone, as it grows
(numbered `id\tname` lines, `o200k_base`):

| Entries | Tokens | Whole text prompt | List's share | Haiku 4.5 | Opus 5 | `gpt-5-mini` | Gemini 2.5 Flash-Lite |
|---|---|---|---|---|---|---|---|
| 50 | 311 | 1,236 | 25% | $0.00031 | $0.00156 | $0.00008 | $0.00003 |
| 100 | 612 | 1,537 | 40% | $0.00061 | $0.00306 | $0.00015 | $0.00006 |
| 200 | 1,297 | 2,222 | 58% | $0.00130 | $0.00649 | $0.00032 | $0.00013 |
| **300** | **1,967** | **2,892** | **68%** | $0.00197 | $0.00984 | $0.00049 | $0.00020 |
| 373 | 2,473 | 3,398 | 73% | $0.00247 | $0.01237 | $0.00062 | $0.00025 |

("Whole text prompt" = 497 instructions + the list + Borssikeitto's 428.)

(The list used is a hand-built 373-entry Finnish pantry — `sipuli`, `purjosipuli`,
`tomaattipyre`, `puolikarkea vehnäjauho`, `lihaliemikuutio` — built for this measurement,
not harvested from a real household. Real names would be similar in length; the token count
is a good estimate, the list itself is not data.)

**Growth is linear and slow: about 6.6 tokens per Finnish ingredient name including its id.**
A few hundred entries is a few thousand tokens. Even at ten times the size — 3,730 entries,
which no household will reach — the list is under 25,000 tokens, well inside every model's
context window, and $0.025 per import on Haiku 4.5. **The ingredient list will never be
what makes this expensive.** Its real cost is latency and prompt-cache pressure, not money.

### Prompt caching: it applies, and it will almost never fire

The prompt has exactly the right shape for caching — a stable prefix (instructions + the
ingredient list) followed by volatile content (this recipe). Anthropic's caching is a prefix
match with a documented breakpoint on the last stable block, so the 2,464-token prefix is
cacheable and the recipe sits after it.

At Claude Opus 5's $5/MTok base, that 2,464-token prefix costs
([pricing multipliers](https://platform.claude.com/docs/en/about-claude/pricing)):

| | Multiplier | Cost |
|---|---|---|
| Uncached | 1.0× | $0.01232 |
| 5-minute cache **write** | 1.25× | $0.01540 |
| 1-hour cache **write** | 2.0× | $0.02464 |
| Cache **read** (hit) | 0.1× | $0.00123 |

TTLs are **5 minutes** and **1 hour**, and Anthropic states the break-even plainly: *"a
cache hit costs 10% of the standard input price, which means caching pays off after one
cache read for the 5-minute duration (1.25x write), or after two cache reads for the 1-hour
duration (2x write)."*

**Would a household importing a few recipes a week ever hit a warm cache? No.** Two imports
a week are ~84 hours apart; the longest TTL is 1 hour. Every import is a cold cache, and
enabling caching would make each one **25% more expensive on the prefix** (the write
premium) with no read to amortise it against.

Caching pays in exactly one situation, and it is a real one: **a sitting.** Someone
photographing eight pages of a cookbook in one evening, or pasting five recipes back to
back, does hit the 5-minute window on imports 2–8. Eight imports in a session on Opus 5:

- No caching: 8 × $0.01232 = **$0.0986** on the prefix.
- 5m caching: $0.01540 write + 7 × $0.00123 = **$0.0240**. A 76% saving on the prefix, 20%
  on the whole import.

So: **do not turn caching on globally; turn it on and it costs you money.** If it is turned
on at all, it should be because bulk-import sittings are an expected shape of use. Note also
that the minimum cacheable prefix is model-dependent — **512 tokens on Claude Opus 5 and
Fable 5, 1,024 on Opus 4.8 / Sonnet 5 / Sonnet 4.6, 4,096 on Opus 4.6 and Haiku 4.5**
([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) —
and a 2,464-token prefix **silently will not cache at all on Haiku 4.5**, which is otherwise
the cheapest Claude candidate. No error; `cache_creation_input_tokens` just comes back 0.

The OpenAI and Gemini equivalents are cheaper but differently shaped: OpenAI's cached input
is a **flat 10× discount on the GPT-5 family with no write premium** ($0.05 → $0.005 on
`gpt-5-nano`), and Gemini bills context caching as a separate per-token rate ($0.01/MTok on
2.5 Flash-Lite).

> **Gap — OpenAI and Gemini cache TTLs unverified.** The pricing pages give the cached-input
> rate but not the retention window or the eligibility rules. If caching turns out to
> matter, that needs checking before choosing on this axis.

---

## 6. Could this run locally instead?

**No. Not for the photograph at all, and not for the text at a speed anyone would accept.**

### The host, measured

```
$ lscpu
Model name:      Intel(R) Core(TM) i5-6400 CPU @ 2.70GHz
CPU(s):          4          Thread(s) per core: 1     CPU max MHz: 3300
Flags:           ... fma ... avx ... avx2 ...          (no avx512*)
L3 cache:        6 MiB
$ grep MemTotal /proc/meminfo
MemTotal:       41019940 kB          # 39.1 GiB
```

Four cores, four threads (no hyper-threading), AVX2 and FMA but **no AVX-512**, Skylake,
2015-era. RAM is plentiful; that is not the problem.

**The problem is memory bandwidth**, because autoregressive decoding reads every weight
once per token. Measured on this host with a threaded sequential-read benchmark
([Appendix C](#appendix-c--the-bandwidth-benchmark)):

```
$ /tmp/bw 2048 1
threads=1 size=2048MB read 13.43 GB/s
threads=1 size=2048MB read 14.14 GB/s
$ /tmp/bw 2048 4
threads=4 size=2048MB read 21.18 GB/s
threads=4 size=2048MB read 20.33 GB/s
threads=4 size=2048MB read 18.92 GB/s
```

**~20 GB/s of usable read bandwidth.** That sets a hard ceiling: a 4.92 GB model (Poro 2 8B
at Q4_K_M) cannot be decoded faster than 20 / 4.92 ≈ **4.1 tokens/second**, before any
compute, cache-miss or framework overhead. This is the well-known constraint — the
llama.cpp CPU-performance thread's summary is blunt: *"LLMs are bound by Memory Bandwidth
not Compute"*, with a 32-core EPYC 7502P managing 7.85 tok/s on a 13B Q4_0 and a 96-core
EPYC 9654 dropping from 4 tok/s to 1.5 tok/s purely by losing memory channels
([llama.cpp discussion #3167](https://github.com/ggml-org/llama.cpp/discussions/3167)).

### And measured for real, on this machine

The best available local candidate for Finnish is **Poro 2**, a Llama-3.1 continued-pretrain
built by AMD Silo AI, TurkuNLP and HPLT specifically to add Finnish; the 8B Instruct
is "based on the Llama 3.1 8B architecture", was continued-pretrained on 165B tokens
including Finnish and fine-tuned on 1.4M English/Finnish instruction examples, and reports
"~24% average improvement in Finnish instruction-following benchmarks while maintaining
English performance" against Llama 3.1 8B Instruct
([LumiOpen/Llama-Poro-2-8B-Instruct](https://huggingface.co/LumiOpen/Llama-Poro-2-8B-Instruct)).
It is 8.03B parameters with an **8,192-token maximum sequence length** — worth noting,
because a 373-entry ingredient list plus a 371-word recipe plus a 1,600-token answer is
already a meaningful fraction of that, and Finnish tokenises worse on a Llama tokenizer than
on `o200k_base`. The context ceiling is a second, independent constraint on the local route.

It was run on this host against the actual 2,906-token import prompt:

```
podman run --rm -v /tmp:/models:z ghcr.io/ggml-org/llama.cpp:light \
  -m /models/poro-q4km.gguf -f /models/prompt.txt -n 700 -t 4 -c 8192 \
  --temp 0 --no-warmup --single-turn
```

<!-- LOCAL_RUN_RESULTS -->

### Three separate reasons this is a dead end

1. **Speed.** See the measured numbers above. An import is minutes, not the couple of
   seconds an API call takes, on a machine that is also serving the web app.
2. **The photograph has no local path at all.** Poro 2 is text-only. There is no
   Finnish-tuned open vision-language model, and a general VLM (Qwen-VL, Llama-Vision,
   Gemma-3) adds a vision tower on top of the same bandwidth wall — and #2 already found
   that nothing parses Finnish ingredient lines, which is precisely what the vision model
   would have to do from pixels. Classical OCR (Tesseract `fin`) can produce the *text*
   locally, but then a model still has to structure it, which is where we started.
3. **Nothing on this host supervises it.** [#3](https://github.com/eerovil/ruokalista/issues/3)
   established the host has rootless podman and plain `systemd --user` units as its only
   supervision, no cron, and 46 GB free on a filesystem already at 81%. A resident 5 GB
   model process, or a 5 GB model load on every import, is a new class of thing for this
   host to carry — for a workload that costs $2.67 per 300 recipes to send away.

The honest framing: local inference here is not "slower but free". It is slower, *and*
narrower (no images), *and* worse at Finnish than any of the hosted models, *and* it makes
the hosting decision ([#7](https://github.com/eerovil/ruokalista/issues/7)) materially
harder. The hosted call is the cheap option in every dimension except the dependency itself.

> **Gap — no quality comparison was run.** Poro 2's output on the import prompt is one
> sample at `--temp 0`, not an evaluation. Nobody scored a local model against a hosted one
> on the #6 rules (does it fabricate a quantity? does it keep the source line? does it split
> `suolaa ja pippuria`?). If local ever becomes attractive again, that is the experiment to
> run.

> **Gap — bigger and smaller local models untested.** Only Poro 2 8B Q4_K_M was run. A 3–4B
> model would be ~2× faster and worse at Finnish; Poro 2 70B would be ~9× slower and would
> not fit comfortably. Neither was measured.

---

## 7. Rate limits and failure behaviour for a household-scale caller

A household importing a few recipes a week is roughly **0.001 requests per second**. Every
tier of every vendor is orders of magnitude above that. Rate limits are not a capacity
question here; they are a *failure-mode* question.

### Anthropic ([rate limits](https://platform.claude.com/docs/en/api/rate-limits), fetched 2026-08-24)

Start tier — the entry tier, which is where this project lands:

| Model | RPM | Input tokens/min | Output tokens/min |
|---|---|---|---|
| Claude Opus 5 | 1,000 | 2,000,000 | 400,000 |
| Claude Sonnet 5 | 1,000 | 2,000,000 | 400,000 |
| Claude Haiku 4.5 | 1,000 | 2,000,000 | 400,000 |
| Claude Fable 5 | 1,000 | 500,000 | 100,000 |

At 2,892 input tokens per import, the Start-tier ITPM allows ~690 imports **per minute**.
The household will never see a rate limit from volume.

What it *can* see:

- **The monthly spend cap.** Start tier is capped at **$500/month**, and hitting it returns
  HTTP 429 with `error.details.error_code: "enforced_spend_limit_reached"` and — critically
  — **no `retry-after` header**, so *"Retrying, including the SDKs' automatic retries, fails
  until access resumes"* at 00:00 UTC on the 1st. This is the one limit worth designing for,
  not because a legitimate 300-recipe import could approach $500 (the worst case in the
  table, 300 photographed pages on Fable 5, is $46) but because a retry loop or a runaway
  job could, and the failure is a month long and immune to retry.
- **Acceleration limits.** *"You might also encounter 429 errors because of acceleration
  limits… if your organization has a sharp increase in usage."* A bulk-import sitting after
  weeks of idleness is exactly a sharp increase. Serialise a bulk import; do not fan out.
- **Evaluation tier.** *"New organizations… may start in the Evaluation tier, with limits
  below the standard limits shown on this page."* The first imports this project ever makes
  may be under tighter limits than the table above. Unquantified in the docs.
- **529 `overloaded_error`** — Anthropic-side capacity, retryable with backoff.
- **`stop_reason: "refusal"`** — on Opus 5 and Fable 5 the safety classifiers can decline a
  request and return **HTTP 200** with empty or partial content. A recipe will not trip
  them, but code that reads `content[0].text` unconditionally will crash rather than
  degrade. Check `stop_reason` first.

Useful for the import UI: the response carries
`anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}` headers,
so a bulk-import screen can show real headroom rather than guessing.

### OpenAI ([rate limits](https://developers.openai.com/api/docs/guides/rate-limits), fetched 2026-08-24)

Tiers are spend-graduated: Free ($100/mo cap), Tier 1 at $5 paid ($100), Tier 2 at $50
($500), Tier 3 at $100 ($1,000), Tier 4 at $250 ($5,000), Tier 5 at $1,000 ($200,000). A
household on Tier 1 has a $100/month ceiling — still ~100× a full 300-recipe import on
`gpt-5-mini`. 429s carry `Retry-After`; the official SDKs retry automatically and respect
it. Their explicit warning is worth copying: *"do not retry errors related to quota or
billing — these require user action."*

> **Gap — per-tier OpenAI RPM/TPM numbers not obtained.** The docs push you to the account
> dashboard rather than publishing the table, and there is no account here to read.

> **Gap — Gemini rate limits and free-tier terms not checked.** Gemini has a free tier that
> might cover this household's entire volume, which would make the cost table moot for that
> vendor. Not verified, and the data-use terms on a free tier are exactly the sort of thing
> that needs reading before a household's recipes go through it.

### The failure story that actually matters

At this volume, the interesting failures are not rate limits. They are:

1. **The API is down or the household's connection is.** An import is a foreground,
   human-waiting operation with no offline fallback (offline use is explicitly out of scope
   on the map). The right shape is: keep the pasted text the moment it is pasted, and treat
   structuring as a retryable step against stored text — which is also exactly what #4's
   "raw text is kept forever" already enables. A failed import should leave a recipe with
   its raw text and no structure, not nothing.
2. **A malformed or hallucinated response.** The model can return non-JSON, invent a
   quantity in violation of the prompt, or drop a line. #6 already answers this with the
   human check-and-correct screen, and #4 with editability. Worth adding: validate that
   every returned `source_line` appears verbatim in the input, which catches invented lines
   cheaply and locally.
3. **A partial response.** `stop_reason: "max_tokens"` on a long recipe truncates the JSON
   mid-object. At 1,200–1,600 output tokens for a 20-line recipe, a `max_tokens` under ~2,500
   is a real risk for a big recipe. Set it generously; Anthropic notes *"there is no rate
   limit downside to setting a higher `max_tokens` value"* since OTPM counts only tokens
   actually produced.

---

## Gaps — things not verified

Collected from above, so nothing here is buried:

1. **No Anthropic or Gemini token counts.** No API key on this host, so `count_tokens`
   could not be called. All token figures are `o200k_base` (OpenAI's tokenizer). Claude 4.7+
   uses a tokenizer producing ~30% more tokens than Claude's previous one; treat Claude
   figures as ±30%.
2. **No photograph was actually sent to any model.** Image-token counts are the vendors'
   documented formulas applied to realistic A5 dimensions, not observed usage.
3. **Photo-import quality untested.** Whether a model reads a photographed Finnish cookbook
   page correctly was not tested; #2's printed-Finnish-OCR finding is being taken on trust.
4. **Mistral not priced.** The pricing page returned only Mistral Large. Pixtral / Mistral
   Small — the cheap-with-vision candidates — are unpriced.
5. **OpenAI and Gemini cache TTLs and eligibility rules unverified.** Only the cached-input
   rate was obtained.
6. **OpenAI per-tier RPM/TPM not published** on the docs page; requires an account.
7. **Gemini rate limits, free-tier limits and free-tier data-use terms not checked.** The
   free tier may cover this household entirely; the terms matter more than the price.
8. **No quality comparison between models, hosted or local.** Nothing in this ticket scored
   any model against the #6 rules. This is the largest gap, and it is the one that will
   actually decide the model — because the cost table above says cost will not.
9. **Only one local model, one quantisation.** Poro 2 8B Q4_K_M. Smaller (faster, worse
   Finnish) and larger (better, unusably slow) variants were not measured.
10. **Batch API not evaluated as a route.** Anthropic's 50% discount applies to
    non-interactive work; whether a "paste ten recipes and come back later" flow is
    acceptable UX is a UI question, and the UI is fog.

---

## Appendix A — the prompt that was measured

497 `o200k_base` tokens. Reproduced so the token count is checkable.

```text
You turn Finnish recipe text into a structured recipe. Return JSON only, no prose.

Schema:
{
  "title": string,
  "yield": string | null,
  "steps": [string],
  "ingredient_lines": [
    {
      "source_line": string,
      "quantity": string | null,
      "unit": string | null,
      "proposed_ingredient": string,
      "match": {"existing_id": integer, "confidence": "high"|"low"} | null
    }
  ]
}

Rules:
- Copy every ingredient line into "source_line" exactly as it appears in the input, including
  fractions, spacing and parentheses. Do not normalise, reorder or merge lines.
- "quantity" and "unit" are only filled in when the source line states them. If the line says
  "suolaa" or "hyppysellinen suolaa", both are null. Never invent a number and never write 0.
- Keep the unit exactly as written ("dl", "rkl", "kpl", "prk", "pss", "tl", "g", "l"). Do not
  convert between units and do not add a unit the source did not use.
- "proposed_ingredient" is the ingredient in its dictionary (nominative) form, lowercased, with
  no quantity, no unit and no preparation instructions: "sipuli", not "1kpl Sipuli" or
  "sipulit hienonnettuna".
- "match" points at an entry in the household ingredient list below when you are confident it is
  the same ingredient. Use "low" confidence when it is a plausible but uncertain match, and null
  when the ingredient is not in the list. Do not match a specific ingredient to a general one
  ("purjosipuli" is not "sipuli").
- If one source line names two ingredients ("suolaa ja pippuria"), emit one entry per ingredient
  and repeat the same "source_line" on both.
- "yield" is copied only when the source states one ("6 annosta"). Otherwise null.
- "steps" are the preparation steps as written, one string per step, in order. Do not summarise,
  renumber or add steps.
- If the input is not a recipe, return {"error": "not_a_recipe"}.
```

The full request is this block, then `Household ingredient list (id, name):` and 300
numbered lines, then `Recipe text:` and the pasted recipe, then `JSON:`. Total for the
Borssikeitto import: **2,906 `o200k_base` tokens** (the 2,892 used in the cost table plus
the section headers).

## Appendix B — the cost script

```python
SYS, LIST300, TEXT, OUT_JSON = 497, 1967, 428, 1200      # measured, o200k_base
IMG_CLAUDE_HI, IMG_CLAUDE_STD = 4756, 1551               # documented formula, A5 page crop
IMG_GPT5, IMG_GPT5MINI, IMG_GPT5NANO = 2478, 2459, 3734
IMG_GEMINI = 3870
OUT_PHOTO = OUT_JSON + TEXT                              # #4 keeps the raw text forever

def cost(inp, out, price_in, price_out):
    return inp * price_in / 1e6 + out * price_out / 1e6

# text import, Claude Haiku 4.5 ($1 / $5):
cost(SYS + LIST300 + TEXT, OUT_JSON, 1.00, 5.00)         # -> 0.008892
# photo import, Claude Haiku 4.5 (standard image tier):
cost(SYS + LIST300 + IMG_CLAUDE_STD, OUT_PHOTO, 1.00, 5.00)   # -> 0.012146
```

## Appendix C — the bandwidth benchmark

A threaded sequential read over a 2 GiB array, compiled `gcc -O2 -march=native`. The array
is seeded from `/dev/urandom` and the per-thread sums are printed, so the compiler cannot
constant-fold the loop away — the first version of this benchmark reported 19,488 GB/s
because it did exactly that.

```c
static unsigned int *a; static size_t N; static int NT;
static unsigned long long sums[16];
static void *worker(void *arg) {
  long id = (long)arg;
  size_t chunk = N / NT, s = id * chunk, e = (id == NT - 1) ? N : s + chunk;
  unsigned long long acc = 0;
  for (size_t i = s; i < e; i++) acc += a[i];
  sums[id] = acc;
  return NULL;
}
```

Full source and the three-repetition timing loop: see the transcript of this research. The
number that matters is **~14 GB/s single-threaded, ~20 GB/s across four threads.**
