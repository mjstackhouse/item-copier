import { expect, test } from "vitest";

import { planRow, publishingState } from "../test/fixtures";
import { groupByItem, mainResult } from "./itemResults";
import type { Prediction } from "./publishing";

const draft = publishingState("draft");
const row = (id: string, languageCodename: string, targetStatus: "new item" | "overwrites existing" = "new item") =>
  planRow({ id, languageCodename, targetStatus, sourcePublishing: draft });
const prediction = (...effects: Prediction["effects"]): Prediction => ({ outcome: "Draft", effects: [...effects] });

test("a change to what is published outranks an overwrite", () => {
  expect(mainResult(row("a", "en", "overwrites existing"), prediction("goes live"))).toBe("goes live");
  expect(mainResult(row("a", "en", "overwrites existing"), prediction())).toBe("overwrites existing");
  expect(mainResult(row("a", "en"), prediction("replaces live content", "unpublished"))).toBe("unpublished");
});

test("groups variants by item, keeping the order items first appear in", () => {
  const items = groupByItem([
    { row: row("b", "en"), prediction: prediction() },
    { row: row("a", "en"), prediction: prediction() },
    { row: row("b", "cs"), prediction: prediction() },
  ]);
  expect(items.map((i) => [i.id, i.variants.map((v) => v.row.languageCodename)])).toEqual([
    ["b", ["en", "cs"]],
    ["a", ["en"]],
  ]);
});

test("sums an item up with its riskiest result, and counts the other results", () => {
  const [same] = groupByItem([
    { row: row("a", "en", "overwrites existing"), prediction: prediction() },
    { row: row("a", "cs", "overwrites existing"), prediction: prediction() },
  ]);
  expect(same).toMatchObject({ main: "overwrites existing", otherResults: 0 });

  const [mixed] = groupByItem([
    { row: row("a", "en", "overwrites existing"), prediction: prediction() },
    { row: row("a", "cs", "overwrites existing"), prediction: prediction("goes live") },
    { row: row("a", "de"), prediction: prediction() },
  ]);
  expect(mixed).toMatchObject({ main: "goes live", otherResults: 2 });
});
