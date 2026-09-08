/**
 * Package sizes, and which packages cover a week's need.
 *
 * The shopping list says what the cooking needs — 700 g of jauheliha. The shop
 * sells packets, and the same foodstuff comes in several of them. This module
 * is the arithmetic in between, and it is deliberately the only place that
 * knows about it: `shopping.ts` still refuses to convert anything for display
 * (5 dl and 2 rkl of milk stay two amounts), and nothing here changes that.
 *
 * Two rules keep it honest:
 *
 *   - **Only exact conversions, only inside one family.** A kilo is a thousand
 *     grams and a decilitre is a hundred millilitres; those are definitions.
 *     Grams to millilitres is a density this app does not know, and a spoon is
 *     not a reliable millilitre, so neither is offered. `rkl`, `tl`, `prk` and
 *     everything else unknown simply have no base amount, which means no
 *     optimisation rather than a guessed one.
 *   - **An unknown package size is unknown.** A product whose size could not be
 *     read is still perfectly choosable — it just never contributes a package
 *     count, because a made-up count is worse on the shop floor than no count
 *     at all (#161).
 */

/** The three families whose members convert into each other exactly. */
export type UnitFamily = "mass" | "volume" | "count";

interface KnownUnit {
  family: UnitFamily;
  /** How many base units one of these is: grams, millilitres, or pieces. */
  base: number;
}

const UNITS: Record<string, KnownUnit> = {
  g: { family: "mass", base: 1 },
  gr: { family: "mass", base: 1 },
  kg: { family: "mass", base: 1000 },
  ml: { family: "volume", base: 1 },
  cl: { family: "volume", base: 10 },
  dl: { family: "volume", base: 100 },
  l: { family: "volume", base: 1000 },
  kpl: { family: "count", base: 1 },
};

/** The base unit each family's amounts are expressed in, for saying a total. */
const FAMILY_UNIT: Record<UnitFamily, string> = {
  mass: "g",
  volume: "ml",
  count: "kpl",
};

export interface BaseAmount {
  family: UnitFamily;
  /** Grams, millilitres or pieces — whichever the family counts in. */
  amount: number;
}

/**
 * One amount as a base amount, or null when this app cannot say what it is.
 *
 * Null is the common and correct answer: `2 rkl`, `1 pss`, `hieman`, and any
 * line whose unit was never written all land here.
 */
export function baseAmount(
  quantity: number | null,
  unit: string | null,
): BaseAmount | null {
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  const known = UNITS[normaliseUnit(unit)];
  if (known === undefined) return null;
  return { family: known.family, amount: quantity * known.base };
}

function normaliseUnit(unit: string | null): string {
  return (unit ?? "").trim().toLocaleLowerCase("fi").replace(".", "");
}

/** `800 g`, `1,5 l`, `3 kpl` — a base amount said the way a person reads it. */
export function formatBaseAmount({ family, amount }: BaseAmount): string {
  if (family === "mass" && amount >= 1000) return `${decimal(amount / 1000)} kg`;
  if (family === "volume" && amount >= 1000) return `${decimal(amount / 1000)} l`;
  if (family === "volume" && amount >= 100 && amount % 100 === 0) {
    return `${decimal(amount / 100)} dl`;
  }
  return `${decimal(amount)} ${FAMILY_UNIT[family]}`;
}

function decimal(value: number): string {
  return String(Number(value.toFixed(2))).replace(".", ",");
}

// ------------------------------------------------------ reading a size off a name

/**
 * Package sizes as the shop writes them into a product's name.
 *
 * This is a *suggestion made once*, at the moment somebody picks the product,
 * and what it produces is then stored as data (#161). Nothing re-reads a name
 * while building a shopping list.
 *
 * It is written to give up easily. A name that says `2 x 200 g` is a multipack
 * whose total this cannot state without assuming what the `2` multiplies, and a
 * name with two different sizes in it is ambiguous, so both answer null and the
 * member gets an empty field to fill in instead of a wrong number.
 */
export interface PackageSize {
  quantity: number;
  unit: string;
}

const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|cl|dl|l|kpl)(?![a-zäö])/gi;
const MULTIPACK = /\d\s*[x×]\s*\d/i;

export function packageSizeFromName(name: string): PackageSize | null {
  if (MULTIPACK.test(name)) return null;

  const found: PackageSize[] = [];
  for (const match of name.matchAll(SIZE_PATTERN)) {
    const quantity = Number(match[1]!.replace(",", "."));
    const unit = match[2]!.toLocaleLowerCase("fi");
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    found.push({ quantity, unit });
  }
  if (found.length === 0) return null;

  // Several sizes in one name usually means "Juustoa 500 g, rasvaa 17 %" — or a
  // name that mentions the contents as well as the packet. Only agreeing
  // readings are trusted; anything else is left for a person to say.
  const first = found[0]!;
  const firstBase = baseAmount(first.quantity, first.unit);
  for (const size of found.slice(1)) {
    const base = baseAmount(size.quantity, size.unit);
    if (base === null || firstBase === null) return null;
    if (base.family !== firstBase.family || base.amount !== firstBase.amount) {
      return null;
    }
  }
  return first;
}

// ------------------------------------------------------------ covering a need

export interface PackageOption {
  /** Whatever the caller identifies a product by; handed straight back. */
  key: string;
  size: BaseAmount;
}

export interface PackagePick {
  key: string;
  count: number;
}

export interface PackagePlan {
  picks: PackagePick[];
  /** What the chosen packages hold in total, in the family's base unit. */
  total: number;
  /** How much more than the need that is; 0 when it lands exactly. */
  waste: number;
}

/**
 * Keep the existing twelve-packet limit on a plan. This bounds the answer, not
 * the search work: many different sizes can still have many combinations.
 */
const MAX_PACKAGES = 12;

/** Candidate/count trials, including pruned ones; independent of machine speed. */
export const MAX_PACKAGE_SEARCH_STEPS = 10_000;

/** Optional diagnostics for deterministic work-bound checks, reset on each call. */
export interface PackageSearchStats {
  steps: number;
  exhausted: boolean;
}

/**
 * The packages to buy for one need: enough, with the least left over, and — for
 * two answers with the same amount left over — in the fewest packets.
 *
 * With 400 g and 700 g on offer that is 1×400 for 350 g, 1×700 for 600 g,
 * 2×400 for 750 g, and 700+400 for 1100 g, which is the behaviour #161 asks
 * for. It is a search over the sizes rather than a rule about mince, so an
 * ingredient sold in 250 ml and 1 l bottles is solved by the same code.
 *
 * Returns null when there is nothing to say: no need, no sized package in the
 * need's own family, a need too large for the packet cap, or an unfinished
 * search. In that last case even a covering candidate is discarded: it has not
 * been proved optimal. The shopping list keeps its existing no-calculated-total
 * fallback rather than presenting a partially searched plan as the answer.
 *
 * Equal sizes keep the first offered product. Other ties keep the first plan
 * found, visiting larger sizes and higher counts first as before (#260).
 */
export function planPackages(
  need: BaseAmount,
  options: PackageOption[],
  stats?: PackageSearchStats,
): PackagePlan | null {
  if (stats !== undefined) {
    stats.steps = 0;
    stats.exhausted = false;
  }
  if (!Number.isFinite(need.amount) || need.amount <= 0) return null;

  // EANs with equal sizes are interchangeable for this objective. Keep the
  // first in caller preference order, without changing the caller's array.
  const bySize = new Map<number, PackageOption>();
  for (const option of options) {
    const { family, amount } = option.size;
    if (family !== need.family || !Number.isFinite(amount) || amount <= 0) continue;
    if (!bySize.has(amount)) bySize.set(amount, option);
  }
  const usable = [...bySize.values()]
    .sort((a, b) => b.size.amount - a.size.amount);
  if (usable.length === 0) return null;

  let best: PackagePlan | null = null;
  let bestCount = Infinity;
  let steps = 0;
  let exhausted = false;
  const picks: PackagePick[] = [];

  const consider = (total: number, used: number): void => {
    const waste = total - need.amount;
    if (best !== null && (waste > best.waste ||
        (waste === best.waste && used >= bestCount))) return;
    best = { picks: picks.map((pick) => ({ ...pick })), total, waste };
    bestCount = used;
  };

  const walk = (start: number, total: number, used: number): void => {
    if (total >= need.amount) {
      consider(total, used);
      return;
    }
    if (used >= MAX_PACKAGES) return;

    // Skipped sizes are advanced by this loop, not recursive zero-count calls.
    // Every descent buys at least one packet: recursion is bounded by twelve
    // packets, not by the number of distinct sizes, and picks stays small.
    for (let index = start; index < usable.length; index += 1) {
      const option = usable[index]!;
      const size = option.size.amount;
      const remaining = MAX_PACKAGES - used;
      // All later sizes are smaller: none can cover a need this one cannot.
      if (total + size * remaining < need.amount) break;

      for (let count = remaining; count >= 1; count -= 1) {
        // Count pruned trials too, so a wide list cannot bypass the work cap.
        if (steps === MAX_PACKAGE_SEARCH_STEPS) {
          exhausted = true;
          return;
        }
        steps += 1;
        const next = total + size * count;
        if (!Number.isFinite(next)) continue;
        if (best !== null && next - need.amount > best.waste) continue;

        picks.push({ key: option.key, count });
        walk(index + 1, next, used + count);
        picks.pop();
        if (exhausted) return;
        // Zero excess in one packet is an absolute optimum; no later tie wins.
        if (best !== null && best.waste === 0 && bestCount === 1) return;
      }
    }
  };

  walk(0, 0, 0);
  if (stats !== undefined) {
    stats.steps = steps;
    stats.exhausted = exhausted;
  }
  return exhausted ? null : best;
}
