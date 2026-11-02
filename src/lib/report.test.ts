import { expect, test } from "vitest";

import type { CopySummary } from "./copy";
import { buildReport } from "./report";

const summary: CopySummary = {
  itemsOk: 1,
  itemsFailed: 0,
  variantsOk: 1,
  variantsFailed: 0,
  variantsCancelled: 0,
  assetsUploaded: 0,
  assetsUpdated: 0,
  itemsNotRead: [],
  assetsMovedToRoot: [],
  copied: [{ name: "About us", codename: "about_us", languageCodename: "en-US", targetItemId: "item-id" }],
  errors: [],
};

const report = (overrides: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({
    source: { environmentId: "source-env", environmentName: "Production", projectName: "Project" },
    target: { environmentId: "target-env", environmentName: "Staging", projectName: "Project" },
    selection: { linkedItemsDepth: Number.POSITIVE_INFINITY, skipMissingReferences: true },
    languageCodenames: ["en-US"],
    publishMode: "drafts",
    result: { state: "finished", summary },
    log: [{ id: 0, type: "info", message: "Importing", time: new Date("2026-01-01T10:00:00Z") }],
    createdAt: new Date("2026-01-01T10:05:00Z"),
    ...overrides,
  });

test("describes the environments, settings and outcome", () => {
  const text = report();
  expect(text).toContain("From: Project / Production (source-env)");
  expect(text).toContain("Publishing: Copy as drafts");
  expect(text).toContain("Linked items: all levels");
  expect(text).toContain("Skip missing references: yes");
  expect(text).toContain("Outcome: finished");
});

test("links each copied variant to its editor in the target", () => {
  expect(report()).toContain(
    "About us (about_us, en-US): https://app.kontent.ai/goto/edit-item/project/target-env/variant-codename/en-US/item/item-id",
  );
});

test("includes the log and a failure's error", () => {
  const text = report({ result: undefined, error: "Missing item with id 'x'" });
  expect(text).toContain("Outcome: failed");
  expect(text).toContain("Missing item with id 'x'");
  expect(text).toContain("2026-01-01T10:00:00.000Z [info] Importing");
});
