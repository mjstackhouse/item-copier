import { describe, expect, test } from "vitest";

import {
  archivedStepId,
  defaultWorkflow,
  defaultWorkflowId,
  marketingWorkflow,
  publishedStepId,
  publishingState,
  workflowSteps,
} from "../test/fixtures";
import {
  canArchiveFromFirstStep,
  findStep,
  firstSteps,
  predict,
  requiredWorkflow,
  stepKindOf,
  targetStepFor,
} from "./publishing";

const steps = workflowSteps(defaultWorkflow, marketingWorkflow);

describe("predict, Match the source", () => {
  const match = (source = publishingState("published"), target?: ReturnType<typeof publishingState>) =>
    predict({ mode: "match", source, target, latestStepName: "Review", firstStepName: "Draft" });

  test("a published item new to the target goes live", () => {
    expect(match()).toEqual({ outcome: "Published", effects: ["goes live"] });
  });

  test("a published item replaces live content in the target", () => {
    expect(match(publishingState("published"), publishingState("published")).effects).toEqual([
      "replaces live content",
    ]);
  });

  test("an item that isn't published in the source is removed from the target's live site", () => {
    const result = match(publishingState("draft"), publishingState("published"));
    expect(result.outcome).toBe("Not published, in the Review step");
    expect(result.effects).toEqual(["removed from live site"]);
  });

  test("a draft over a published version stays published", () => {
    const result = match(publishingState("draft", { hasPublishedVersion: true }), publishingState("published"));
    expect(result.outcome).toBe("Published, with a newer draft in the Review step");
    expect(result.effects).toEqual(["replaces live content"]);
  });

  test("a schedule in the target is replaced", () => {
    const target = publishingState("scheduled", { publishTime: "2030-01-01T10:00:00Z" });
    expect(match(publishingState("draft"), target).effects).toEqual(["schedule replaced"]);
  });

  test("the source's scheduled publishing is copied", () => {
    const source = publishingState("scheduled", { publishTime: "2030-01-01T10:00:00Z" });
    expect(match(source).outcome).toMatch(/^Scheduled to publish on /);
    expect(match({ ...source, hasPublishedVersion: true }).outcome).toMatch(
      /^Published, with a new version scheduled to publish on /,
    );
  });

  test("the source's scheduled unpublishing is copied", () => {
    const source = publishingState("published", { unpublishTime: "2030-01-01T10:00:00Z" });
    expect(match(source).outcome).toMatch(/^Published, scheduled to unpublish on /);
  });

  test("an archived item stays archived", () => {
    expect(match(publishingState("archived")).outcome).toBe("Archived");
  });
});

describe("predict, Copy as drafts", () => {
  const drafts = (source: ReturnType<typeof publishingState>, target?: ReturnType<typeof publishingState>) =>
    predict({ mode: "drafts", source, target, latestStepName: "Review", firstStepName: "Draft" });

  test("a live target version stays live, with the copy as a draft in the first step", () => {
    expect(drafts(publishingState("published"), publishingState("published"))).toEqual({
      outcome: "Live version unchanged, with the copied content as a new draft in the Draft step",
      effects: [],
    });
  });

  test("a draft keeps its step", () => {
    expect(drafts(publishingState("draft")).outcome).toBe("Not published, in the Review step");
  });

  test("nothing goes live, even for a published source item", () => {
    expect(drafts(publishingState("published")).effects).toEqual([]);
  });

  test("a schedule in the target is cancelled and none is copied", () => {
    const target = publishingState("draft", { publishTime: "2030-01-01T10:00:00Z" });
    expect(drafts(publishingState("published"), target).effects).toEqual(["schedule cancelled"]);
  });

  test("an archived item stays archived", () => {
    expect(drafts(publishingState("archived"))).toEqual({ outcome: "Archived", effects: [] });
  });

  test("an unknown step is described as such", () => {
    const result = predict({
      mode: "drafts",
      source: publishingState("draft"),
      target: undefined,
      latestStepName: "",
      firstStepName: "",
    });
    expect(result.outcome).toBe("Not published, in an unknown workflow step");
  });
});

describe("findStep", () => {
  test("tells apart the shared Published step of different workflows", () => {
    expect(findStep(steps, { workflowId: marketingWorkflow.id, stepId: publishedStepId })?.workflowCodename).toBe(
      "marketing",
    );
    expect(findStep(steps, { workflowId: defaultWorkflowId, stepId: publishedStepId })?.workflowCodename).toBe(
      "default",
    );
  });
});

describe("stepKindOf", () => {
  test("finds a step by the codenames the toolkit uses", () => {
    expect(stepKindOf(steps, "default", "published")).toBe("published");
    expect(stepKindOf(steps, "marketing", "legal_review")).toBe("draft");
  });

  test("treats an unknown step as a draft", () => {
    expect(stepKindOf(steps, "default", "legal_review")).toBe("draft");
  });
});

describe("firstSteps", () => {
  test("is each workflow's first own step", () => {
    const first = firstSteps(steps);
    expect(first.get("default")?.codename).toBe("draft");
    expect(first.get("marketing")?.codename).toBe("copywriting");
  });
});

describe("targetStepFor", () => {
  test("uses the step with the same codename", () => {
    expect(targetStepFor(steps, "default", { codename: "review", kind: "draft" })?.codename).toBe("review");
  });

  test("falls back to the first step for a draft step the target lacks", () => {
    expect(targetStepFor(steps, "default", { codename: "legal_review", kind: "draft" })?.codename).toBe("draft");
  });

  test("falls back to the step of the same kind for Published, Archived and Scheduled", () => {
    expect(targetStepFor(steps, "marketing", { codename: "renamed_published", kind: "published" })?.id).toBe(
      publishedStepId,
    );
  });

  test("finds nothing in a workflow the target doesn't have", () => {
    expect(targetStepFor(steps, "legal", { codename: "draft", kind: "draft" })).toBeUndefined();
  });
});

describe("requiredWorkflow", () => {
  test("is the workflow whose scope covers the content type", () => {
    expect(requiredWorkflow(steps, "campaign-type", "any-collection")?.codename).toBe("marketing");
  });

  test("is the default workflow when no scope covers the item", () => {
    expect(requiredWorkflow(steps, "article-type", "any-collection")?.codename).toBe("default");
  });

  test("needs both the content type and the collection when a scope names both", () => {
    const scoped = workflowSteps(defaultWorkflow, {
      ...marketingWorkflow,
      scopes: [{ contentTypeIds: ["campaign-type"], collectionIds: ["emea"] }],
    });
    expect(requiredWorkflow(scoped, "campaign-type", "emea")?.codename).toBe("marketing");
    expect(requiredWorkflow(scoped, "campaign-type", "us")?.codename).toBe("default");
  });
});

describe("canArchiveFromFirstStep", () => {
  test("is true when the first step can move to Archived", () => {
    expect(canArchiveFromFirstStep(steps, "default")).toBe(true);
  });

  test("is false when it can't", () => {
    expect(canArchiveFromFirstStep(steps, "marketing")).toBe(false);
  });

  test("is false for a workflow the environment doesn't have", () => {
    expect(canArchiveFromFirstStep(steps, "legal")).toBe(false);
  });

  test("checks the Archived step of the right workflow", () => {
    // Both workflows share the Archived step's id, so only the first step's transitions decide.
    const archivable = workflowSteps({
      ...marketingWorkflow,
      steps: [{ id: "copywriting-step", codename: "copywriting", transitionsTo: [archivedStepId] }],
    });
    expect(canArchiveFromFirstStep(archivable, "marketing")).toBe(true);
  });
});
