import { describe, expect, test } from "vitest";

import { planRow, publishingState } from "../test/fixtures";
import { type Plan, type PlanRow, publishModeBlockers } from "./plan";

const planOf = (rows: readonly PlanRow[]): Plan => ({
  rows,
  blockers: [],
  notes: [],
  deletedReferenceCount: 0,
  skippedVariants: [],
});

const archivedOverLive = planRow({
  sourcePublishing: publishingState("archived"),
  targetPublishing: publishingState("published"),
});

describe("publishModeBlockers", () => {
  test("blocks an item archived in the source but live in the target, in Copy as drafts", () => {
    const blockers = publishModeBlockers(planOf([archivedOverLive]), "drafts", "Staging");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("live in Staging");
    expect(blockers[0]).toContain("Item 1");
  });

  test("doesn't block it in Match the source, which unpublishes it on purpose", () => {
    expect(publishModeBlockers(planOf([archivedOverLive]), "match", "Staging")).toEqual([]);
  });

  test("doesn't block an archived item that isn't live in the target", () => {
    const rows = [
      planRow({ sourcePublishing: publishingState("archived") }),
      planRow({ sourcePublishing: publishingState("archived"), targetPublishing: publishingState("draft") }),
    ];
    expect(publishModeBlockers(planOf(rows), "drafts", "Staging")).toEqual([]);
  });

  test("blocks a draft over a published version in the target, which is live too", () => {
    const row = planRow({
      sourcePublishing: publishingState("archived"),
      targetPublishing: publishingState("draft", { hasPublishedVersion: true }),
    });
    expect(publishModeBlockers(planOf([row]), "drafts", "Staging")).toHaveLength(1);
  });

  test("names each item once, however many of its languages are affected", () => {
    const blockers = publishModeBlockers(
      planOf([archivedOverLive, { ...archivedOverLive, languageCodename: "cs" }]),
      "drafts",
      "Staging",
    );
    expect(blockers[0]?.match(/Item 1/g)).toHaveLength(1);
  });
});
