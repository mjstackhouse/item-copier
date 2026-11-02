import { expect, test } from "vitest";

import { emptySelection, languagesToCopy } from "./selection";

const languages = ["en", "cs", "de"].map((codename, i) => ({
  id: codename,
  codename,
  name: codename,
  isDefault: i === 0,
}));

test("copies every language by default", () => {
  expect(languagesToCopy(emptySelection, languages)).toEqual(["en", "cs", "de"]);
});

test("copies the chosen languages in the source's order", () => {
  expect(languagesToCopy({ copyAllLanguages: false, chosenLanguages: ["de", "en"] }, languages)).toEqual(["en", "de"]);
});

test("ignores a chosen language the source no longer has", () => {
  expect(languagesToCopy({ copyAllLanguages: false, chosenLanguages: ["fr"] }, languages)).toEqual([]);
});
