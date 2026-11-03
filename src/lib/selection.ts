import type { Item, Language } from "./kontent";

/** What the user chose to copy and how. */
export type Selection = {
  /** The language to search in. */
  readonly languageCodename: string;
  /** True to copy every language; otherwise only `chosenLanguages`. */
  readonly copyAllLanguages: boolean;
  /** The languages picked under "Choose languages", in the source's language order. */
  readonly chosenLanguages: readonly string[];
  readonly pickedItems: readonly Item[];
  /** In a dialog: the key of the Kontent.ai selection `pickedItems` were loaded from (`selectionKey`). */
  readonly pickedFromKey?: string;
  readonly linkedItemsDepth: number;
  readonly skipMissingReferences: boolean;
};

export const emptySelection: Selection = {
  languageCodename: "",
  // Copying an item usually means all of its translations.
  copyAllLanguages: true,
  chosenLanguages: [],
  pickedItems: [],
  linkedItemsDepth: 1,
  skipMissingReferences: false,
};

/** The codenames of the languages to copy, in the source's language order. */
export const languagesToCopy = (
  selection: Pick<Selection, "copyAllLanguages" | "chosenLanguages">,
  languages: readonly Language[],
): string[] =>
  languages.map((l) => l.codename).filter((c) => selection.copyAllLanguages || selection.chosenLanguages.includes(c));
