/** A named recipe part after equivalent section spellings are grouped. */
export interface RecipeSection {
  key: string;
  /** The first trimmed spelling, used as a new part's display title. */
  title: string;
}

/** The shared identity for a draft section from review through persistence. */
export function recipeSectionKey(
  section: string | null | undefined,
): string | null {
  const title = section?.trim() ?? "";
  return title === "" ? null : title.toLocaleLowerCase("fi");
}

/** Named sections in first-appearance order, with equivalent spellings merged. */
export function recipeSections(
  items: readonly { section: string | null }[],
): RecipeSection[] {
  const sections = new Map<string, RecipeSection>();

  for (const item of items) {
    const title = item.section?.trim() ?? "";
    const key = recipeSectionKey(item.section);
    if (key === null || sections.has(key)) continue;
    sections.set(key, { key, title });
  }

  return [...sections.values()];
}
