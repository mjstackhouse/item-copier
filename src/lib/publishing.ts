import type { ManagementClient } from "@kontent-ai/management-sdk";

import { isNotFound } from "./kontent";

export type StepKind = "draft" | "published" | "archived" | "scheduled";

export type WorkflowStepInfo = {
  readonly name: string;
  readonly codename: string;
  readonly kind: StepKind;
  readonly workflowName: string;
  readonly workflowCodename: string;
};

/**
 * "workflow id/step id" -> the step and its workflow, across all workflows. Keyed by both ids because
 * the Published, Archived and Scheduled steps have the same ids in every workflow; use `findStep`.
 */
export type WorkflowSteps = ReadonlyMap<string, WorkflowStepInfo>;

export const findStep = (steps: WorkflowSteps, state: { readonly workflowId: string; readonly stepId: string }) =>
  steps.get(`${state.workflowId}/${state.stepId}`);

/** The latest version of a variant: its workflow, workflow step and schedule. */
export type VariantState = {
  readonly workflowId: string;
  readonly stepId: string;
  readonly publishTime: string | null;
  readonly unpublishTime: string | null;
};

/** What the copy reads from (source) or replaces (target) for one variant. */
export type PublishingState = {
  readonly stepName: string;
  readonly stepKind: StepKind;
  /** True when a published version exists, either as the latest version or under a newer draft. */
  readonly hasPublishedVersion: boolean;
  readonly publishTime: string | null;
  readonly unpublishTime: string | null;
};

/**
 * Changes to what is live in the target. The toolkit makes the target match the source's
 * publishing state, so these follow from comparing the two.
 */
export type LiveEffect =
  | "goes live"
  | "replaces live content"
  | "removed from live site"
  | "schedule replaced"
  | "schedule cancelled";

/**
 * "match": the target ends up with the source's publishing state (the toolkit's own behavior).
 * "drafts": nothing is published or unpublished. Items live in the target stay live, with the
 * copied content as a new draft on top, and schedules are not copied. See `toDrafts` in copy.ts.
 */
export type PublishMode = "match" | "drafts";

export const loadWorkflowSteps = async (client: ManagementClient): Promise<WorkflowSteps> => {
  const workflows = (await client.listWorkflows().toPromise()).data;
  const steps = new Map<string, WorkflowStepInfo>();

  for (const workflow of workflows) {
    const add = (step: { id: string; name: string; codename: string }, kind: StepKind) =>
      steps.set(`${workflow.id}/${step.id}`, {
        name: step.name,
        codename: step.codename,
        kind,
        workflowName: workflow.name,
        workflowCodename: workflow.codename,
      });
    for (const step of workflow.steps) add(step, "draft");
    add(workflow.publishedStep, "published");
    add(workflow.archivedStep, "archived");
    if (workflow.scheduledStep) add(workflow.scheduledStep, "scheduled");
  }

  return steps;
};

/**
 * Completes a variant's state with whether it has a published version. That takes one more
 * request when the latest version is not the published one (for example a draft of a published item).
 */
export const getPublishingState = async (params: {
  readonly client: ManagementClient;
  readonly steps: WorkflowSteps;
  readonly item: { readonly id: string } | { readonly codename: string };
  readonly languageCodename: string;
  readonly latest: VariantState;
}): Promise<PublishingState> => {
  const step = findStep(params.steps, params.latest) ?? { name: "", kind: "draft" as const };

  const hasPublishedVersion =
    step.kind === "published" ||
    (step.kind !== "archived" && (await hasPublishedVersionAsync(params.client, params.item, params.languageCodename)));

  return {
    stepName: step.name,
    stepKind: step.kind,
    hasPublishedVersion,
    publishTime: params.latest.publishTime,
    unpublishTime: params.latest.unpublishTime,
  };
};

const hasPublishedVersionAsync = async (
  client: ManagementClient,
  item: { readonly id: string } | { readonly codename: string },
  languageCodename: string,
): Promise<boolean> => {
  const query = "id" in item ? client.viewLanguageVariant().byItemId(item.id) : client.viewLanguageVariant().byItemCodename(item.codename);
  try {
    await query.byLanguageCodename(languageCodename).published().toPromise();
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
};

/** The first step of each workflow, by workflow codename: where the toolkit puts new drafts. */
export const firstSteps = (steps: WorkflowSteps): ReadonlyMap<string, WorkflowStepInfo> => {
  const first = new Map<string, WorkflowStepInfo>();
  // Steps are stored in workflow order, so the first draft step seen is the workflow's first step.
  for (const step of steps.values()) {
    if (step.kind === "draft" && !first.has(step.workflowCodename)) first.set(step.workflowCodename, step);
  }
  return first;
};

export type Prediction = {
  /** The state the item will be in, in the target, after the copy. */
  readonly outcome: string;
  /** How the copy changes what is live in the target. */
  readonly effects: readonly LiveEffect[];
};

/**
 * Predicts what the copy does to one item in the target. `target` is undefined when the target
 * has no variant yet; `firstStepName` is the first step of the item's workflow.
 */
export const predict = (params: {
  readonly mode: PublishMode;
  readonly source: PublishingState;
  readonly target: PublishingState | undefined;
  readonly firstStepName: string;
}): Prediction =>
  params.mode === "drafts" ? predictDrafts(params) : { outcome: describeSource(params.source), effects: matchEffects(params) };

/** In "match" mode the target ends up in the source's state. */
const describeSource = (source: PublishingState): string => {
  if (source.publishTime) {
    const when = formatTime(source.publishTime);
    return source.hasPublishedVersion && source.stepKind !== "published"
      ? `Published, with a new version scheduled to publish ${when}`
      : `Scheduled to publish ${when}`;
  }

  switch (source.stepKind) {
    case "published":
      return source.unpublishTime ? `Published, scheduled to unpublish ${formatTime(source.unpublishTime)}` : "Published";
    case "archived":
      return "Archived";
    default:
      return source.hasPublishedVersion
        ? `Published, with a newer draft in ${stepLabel(source.stepName)}`
        : `Not published, in ${stepLabel(source.stepName)}`;
  }
};

const matchEffects = ({ source, target }: { source: PublishingState; target: PublishingState | undefined }) => {
  const effects: LiveEffect[] = [];
  const targetLive = target?.hasPublishedVersion ?? false;

  if (source.hasPublishedVersion) effects.push(targetLive ? "replaces live content" : "goes live");
  else if (targetLive) effects.push("removed from live site");

  // The toolkit cancels any schedule in the target before copying, then applies the source's.
  if (target?.publishTime || target?.unpublishTime) effects.push("schedule replaced");

  return effects;
};

/**
 * In "drafts" mode the copied content becomes a draft: in the source's step when the source's latest
 * version is a draft, otherwise in the workflow's first step. A live target version stays live.
 */
const predictDrafts = ({
  source,
  target,
  firstStepName,
}: {
  source: PublishingState;
  target: PublishingState | undefined;
  firstStepName: string;
}): Prediction => {
  const draftStep = stepLabel(source.stepKind === "draft" ? source.stepName : firstStepName);
  const outcome = target?.hasPublishedVersion
    ? `Live version unchanged, with the copied content as a new draft in ${draftStep}`
    : `Not published, in ${draftStep}`;
  // The toolkit cancels any schedule in the target before copying; drafts mode copies none.
  const effects: LiveEffect[] = target?.publishTime || target?.unpublishTime ? ["schedule cancelled"] : [];
  return { outcome, effects };
};

// The name is empty when the step was not found in the environment's workflows.
const stepLabel = (name: string) => (name ? `the ${name} step` : "an unknown workflow step");

const formatTime = (iso: string) =>
  `on ${new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
