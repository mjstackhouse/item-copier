import type { MigrationData, MigrationItem } from "@kontent-ai/migration-toolkit";
import { describe, expect, test } from "vitest";

import { defaultWorkflow, marketingWorkflow, workflowSteps } from "../test/fixtures";
import { fitStepsToTarget, toDrafts } from "./copy";

const sourceSteps = workflowSteps(defaultWorkflow, marketingWorkflow);
const schedule = { publish_time: "2030-01-01T10:00:00Z" };

const item = (
  versions: readonly { readonly step: string; readonly schedule?: typeof schedule }[],
  workflow = "default",
): MigrationItem => ({
  system: {
    codename: "article_1",
    name: "Article 1",
    language: { codename: "en" },
    type: { codename: "article" },
    collection: { codename: "default" },
    workflow: { codename: workflow },
  },
  versions: versions.map((v) => ({ workflow_step: { codename: v.step }, elements: {}, schedule: v.schedule })),
});

const data = (...items: MigrationItem[]): MigrationData => ({ items, assets: [] });
const stepsOf = (result: MigrationData) => result.items.map((i) => i.versions.map((v) => v.workflow_step.codename));

describe("toDrafts", () => {
  test("drops the published version when there is a newer draft", () => {
    expect(stepsOf(toDrafts(data(item([{ step: "published" }, { step: "review" }])), sourceSteps))).toEqual([
      ["review"],
    ]);
  });

  test("moves a published-only item to the workflow's first step", () => {
    expect(stepsOf(toDrafts(data(item([{ step: "published" }])), sourceSteps))).toEqual([["draft"]]);
    expect(stepsOf(toDrafts(data(item([{ step: "published" }], "marketing")), sourceSteps))).toEqual([["copywriting"]]);
  });

  test("moves a scheduled version to the first step and drops every schedule", () => {
    const result = toDrafts(data(item([{ step: "scheduled", schedule }])), sourceSteps);
    expect(stepsOf(result)).toEqual([["draft"]]);
    expect(result.items[0]?.versions[0]?.schedule).toBeUndefined();
  });

  test("keeps archived items archived", () => {
    expect(stepsOf(toDrafts(data(item([{ step: "archived" }])), sourceSteps))).toEqual([["archived"]]);
  });

  test("tells the patched toolkit to leave the target's published version alone", () => {
    expect(toDrafts(data(item([{ step: "review" }])), sourceSteps).items[0]).toHaveProperty(
      "keepTargetPublished",
      true,
    );
  });
});

describe("fitStepsToTarget", () => {
  test("leaves versions whose step exists in the target alone", () => {
    const input = data(item([{ step: "published" }, { step: "review" }]));
    expect(stepsOf(fitStepsToTarget(input, sourceSteps, sourceSteps, new Map()))).toEqual([["published", "review"]]);
  });

  test("moves a draft step the target lacks to its first step", () => {
    const target = workflowSteps({ ...defaultWorkflow, steps: defaultWorkflow.steps.slice(0, 1) });
    expect(stepsOf(fitStepsToTarget(data(item([{ step: "review" }])), sourceSteps, target, new Map()))).toEqual([
      ["draft"],
    ]);
  });

  test("moves variants to the workflow the target requires", () => {
    const result = fitStepsToTarget(
      data(item([{ step: "published" }, { step: "review" }])),
      sourceSteps,
      sourceSteps,
      new Map([["article_1/en", "marketing"]]),
    );
    expect(result.items[0]?.system.workflow.codename).toBe("marketing");
    // Published keeps its kind; the draft step doesn't exist in that workflow, so it goes to the first step.
    expect(stepsOf(result)).toEqual([["published", "copywriting"]]);
  });

  test("leaves a workflow the target doesn't have alone, for the preview to block", () => {
    const target = workflowSteps(defaultWorkflow);
    expect(
      stepsOf(fitStepsToTarget(data(item([{ step: "legal_review" }], "marketing")), sourceSteps, target, new Map())),
    ).toEqual([["legal_review"]]);
  });
});
