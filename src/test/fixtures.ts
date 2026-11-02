// Small, made-up environments for unit tests, shaped like the data the app loads from the Management API.
import type { PlanRow } from "../lib/plan";
import type { PublishingState, StepKind, WorkflowScope, WorkflowStepInfo, WorkflowSteps } from "../lib/publishing";

// Kontent.ai gives the Published, Archived and Scheduled steps the same ids in every workflow.
export const publishedStepId = "published-step";
export const archivedStepId = "archived-step";
export const scheduledStepId = "scheduled-step";
export const defaultWorkflowId = "00000000-0000-0000-0000-000000000000";

type WorkflowFixture = {
  readonly id: string;
  readonly codename: string;
  readonly name?: string;
  /** The workflow's own steps, in order; the first is where new drafts go. */
  readonly steps: readonly {
    readonly id: string;
    readonly codename: string;
    readonly transitionsTo?: readonly string[];
  }[];
  readonly scopes?: readonly WorkflowScope[];
};

/** Builds `WorkflowSteps` the way `loadWorkflowSteps` does: own steps in order, then Published, Archived and Scheduled. */
export const workflowSteps = (...workflows: readonly WorkflowFixture[]): WorkflowSteps => {
  const steps = new Map<string, WorkflowStepInfo>();
  for (const w of workflows) {
    const add = (id: string, codename: string, kind: StepKind, transitionsTo: readonly string[] = []) =>
      steps.set(`${w.id}/${id}`, {
        id,
        codename,
        name: titleCase(codename),
        kind,
        workflowId: w.id,
        workflowCodename: w.codename,
        workflowName: w.name ?? titleCase(w.codename),
        workflowScopes: w.scopes ?? [],
        transitionsTo,
      });
    for (const s of w.steps) add(s.id, s.codename, "draft", s.transitionsTo);
    add(publishedStepId, "published", "published");
    add(archivedStepId, "archived", "archived");
    add(scheduledStepId, "scheduled", "scheduled");
  }
  return steps;
};

const titleCase = (codename: string) => codename.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The default workflow: Draft, then Review; Draft can move to Review or Archived. */
export const defaultWorkflow: WorkflowFixture = {
  id: defaultWorkflowId,
  codename: "default",
  steps: [
    { id: "draft-step", codename: "draft", transitionsTo: ["review-step", archivedStepId] },
    { id: "review-step", codename: "review", transitionsTo: [publishedStepId] },
  ],
};

/** A scoped workflow whose first step can't move straight to Archived. */
export const marketingWorkflow: WorkflowFixture = {
  id: "marketing-workflow",
  codename: "marketing",
  steps: [
    { id: "copywriting-step", codename: "copywriting", transitionsTo: ["legal-step"] },
    { id: "legal-step", codename: "legal_review", transitionsTo: [publishedStepId] },
  ],
  scopes: [{ contentTypeIds: ["campaign-type"], collectionIds: [] }],
};

export const publishingState = (stepKind: StepKind, overrides: Partial<PublishingState> = {}): PublishingState => ({
  stepName: titleCase(stepKind),
  stepKind,
  hasPublishedVersion: stepKind === "published",
  publishTime: null,
  unpublishTime: null,
  ...overrides,
});

/** A preview row with defaults for everything a test doesn't care about. */
export const planRow = (overrides: Partial<PlanRow> & Pick<PlanRow, "sourcePublishing">): PlanRow => ({
  id: "item-1",
  item: {
    id: "item-1",
    codename: "item_1",
    name: "Item 1",
    typeId: "article-type",
    collectionId: "default-collection",
  },
  languageCodename: "en",
  depth: 0,
  state: { workflowId: defaultWorkflowId, stepId: "draft-step", publishTime: null, unpublishTime: null },
  termIds: [],
  typeCodename: "article",
  targetStatus: "new item",
  targetWorkflowCodename: "default",
  latestStepName: "Draft",
  firstStepName: "Draft",
  ...overrides,
});
