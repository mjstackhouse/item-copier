import { describe, expect, test } from "vitest";

import { planRow, publishingState } from "../test/fixtures";
import { type Plan, type PlanRow, publishModeBlockers, type Unarchivable } from "./plan";

const planOf = (unarchivable: readonly Unarchivable[]): Plan => ({
  rows: unarchivable.map((u) => u.row),
  blockers: [],
  unarchivable,
  notes: [],
  deletedReferenceCount: 0,
  missingAssetCount: 0,
  skippedVariants: [],
});

const unarchivable = (row: PlanRow): Unarchivable => ({ row, workflowName: "Marketing", firstStepName: "Copywriting" });
const archived = planRow({ sourcePublishing: publishingState("archived") });
const archivedOverLive = { ...archived, targetPublishing: publishingState("published") };

describe("publishModeBlockers", () => {
  test("blocks an item that can't be archived in the target", () => {
    for (const mode of ["match", "drafts"] as const) {
      const blockers = publishModeBlockers(planOf([unarchivable(archived)]), mode);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('"Marketing" workflow');
      expect(blockers[0]).toContain("Item 1");
    }
  });

  test("doesn't block it in Copy as drafts over a live target variant, which becomes a draft instead", () => {
    expect(publishModeBlockers(planOf([unarchivable(archivedOverLive)]), "drafts")).toEqual([]);
    expect(publishModeBlockers(planOf([unarchivable(archivedOverLive)]), "match")).toHaveLength(1);
  });

  test("names each item once, however many of its languages are affected", () => {
    const blockers = publishModeBlockers(
      planOf([unarchivable(archived), unarchivable({ ...archived, languageCodename: "cs" })]),
      "match",
    );
    expect(blockers[0]?.match(/Item 1/g)).toHaveLength(1);
  });

  test("blocks nothing when every archived item can be archived", () => {
    expect(publishModeBlockers(planOf([]), "match")).toEqual([]);
  });
});
