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
 * Nobody is buying twelve packets of one thing for one week's cooking. The cap
 * exists so the search is bounded rather than because twelve is meaningful; a
 * need beyond it gets no plan at all, which reads as "we could not work this
 * out" instead of as a trolley full of mince.
 */
const MAX_PACKAGES = 12;

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
 * need's own family, or a need too large for the cap above.
 */
export function planPackages(
  need: BaseAmount,
  options: PackageOption[],
): PackagePlan | null {
  if (need.amount <= 0) return null;

  const usable = options
    .filter((option) => option.size.family === need.family && option.size.amount > 0)
    // Largest first: it reaches a plan that covers the need early, which is what
    // makes the pruning below cut anything at all.
    .sort((a, b) => b.size.amount - a.size.amount);
  if (usable.length === 0) return null;

  let best: PackagePlan | null = null;

  const counts = new Array<number>(usable.length).fill(0);

  const consider = (total: number, used: number): void => {
    const waste = total - need.amount;
    if (best !== null && (waste > best.waste ||
        (waste === best.waste && used >= best.picks.reduce((n, p) => n + p.count, 0)))) {
      return;
    }
    best = {
      picks: usable
        .map((option, index) => ({ key: option.key, count: counts[index]! }))
        .filter((pick) => pick.count > 0),
      total,
      waste,
    };
  };

  const walk = (index: number, total: number, used: number): void => {
    if (total >= need.amount) {
      consider(total, used);
      return;
    }
    if (index >= usable.length || used >= MAX_PACKAGES) return;

    // Even filling every remaining packet with this size — the largest left —
    // cannot reach the need, so no arrangement below here can either.
    const reach = total + usable[index]!.size.amount * (MAX_PACKAGES - used);
    if (reach < need.amount) return;

    const size = usable[index]!.size.amount;
    for (let count = MAX_PACKAGES - used; count >= 0; count -= 1) {
      const next = total + size * count;
      // Overshooting further than the best answer already does is pointless: a
      // bigger pile of this size only makes the waste worse.
      if (best !== null && next - need.amount > best.waste) continue;
      counts[index] = count;
      walk(index + 1, next, used + count);
      counts[index] = 0;
    }
  };

  walk(0, 0, 0);
  return best;
}
