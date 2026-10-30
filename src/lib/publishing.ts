import type { ManagementClient } from "@kontent-ai/management-sdk";

import { isNotFound } from "./kontent";

export type StepKind = "draft" | "published" | "archived" | "scheduled";

/** Which content types and collections a workflow applies to; an empty list means any. */
export type WorkflowScope = { readonly contentTypeIds: readonly string[]; readonly collectionIds: readonly string[] };

export type WorkflowStepInfo = {
  readonly id: string;
  readonly name: string;
  readonly codename: string;
  readonly kind: StepKind;
  readonly workflowName: string;
  readonly workflowCodename: string;
  readonly workflowId: string;
  /** The workflow's scopes; a workflow without scopes applies where no other workflow does. */
  readonly workflowScopes: readonly WorkflowScope[];
  /** Ids of the steps this step can move to (only known for the workflow's own steps, not Published etc.). */
  readonly transitionsTo: readonly string[];
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
    const workflowScopes = workflow.scopes.map((scope) => ({
      contentTypeIds: (scope.content_types ?? []).flatMap((t) => (t.id ? [t.id] : [])),
      collectionIds: (scope.collections ?? []).flatMap((c) => (c.id ? [c.id] : [])),
    }));
    const add = (step: { id: string; name: string; codename: string }, kind: StepKind, transitionsTo: string[] = []) =>
      steps.set(`${workflow.id}/${step.id}`, {
        id: step.id,
        name: step.name,
        codename: step.codename,
        kind,
        workflowName: workflow.name,
        workflowCodename: workflow.codename,
        workflowId: workflow.id,
        workflowScopes,
        transitionsTo,
      });
    for (const step of workflow.steps) {
      const transitions = (step as unknown as { transitions_to?: { step?: { id?: string } }[] }).transitions_to ?? [];
      add(step, "draft", transitions.flatMap((t) => (t.step?.id ? [t.step.id] : [])));
    }
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

/**
 * Where a source step lands in the target's workflow of the same codename: the step with the same codename,
 * or, when the target's workflow lacks it (workflows edited after cloning, for example), its step of the same
 * kind (Published, Archived, Scheduled) or, for a draft step, its first step. Undefined when the target has
 * no workflow with that codename. The copy applies the same rule (see `fitStepsToTarget` in copy.ts).
 */
export const targetStepFor = (
  targetSteps: WorkflowSteps,
  workflowCodename: string,
  step: { readonly codename: string; readonly kind: StepKind },
): WorkflowStepInfo | undefined => {
  // In workflow order, so the first draft step found is the workflow's first step.
  const inWorkflow = [...targetSteps.values()].filter((s) => s.workflowCodename === workflowCodename);
  return (
    inWorkflow.find((s) => s.codename === step.codename) ??
    inWorkflow.find((s) => s.kind === step.kind)
  );
};

// Kontent.ai's default workflow always has this id.
const defaultWorkflowId = "00000000-0000-0000-0000-000000000000";

/**
 * The workflow an environment allows for items of a content type in a collection: the workflow whose scope
 * covers them, otherwise the default workflow. Kontent.ai rejects a variant in any other workflow, for example
 * an older item that stayed in the default workflow after a scope was added for its content type.
 * Pass the environment's own content type and collection ids.
 */
export const requiredWorkflow = (
  steps: WorkflowSteps,
  contentTypeId: string,
  collectionId: string,
): { readonly codename: string; readonly name: string } | undefined => {
  const workflows = [...new Map([...steps.values()].map((s) => [s.workflowId, s])).values()];
  const covers = (scope: WorkflowScope) =>
    (!scope.contentTypeIds.length || scope.contentTypeIds.includes(contentTypeId)) &&
    (!scope.collectionIds.length || scope.collectionIds.includes(collectionId));
  const match =
    workflows.find((w) => w.workflowScopes.some(covers)) ??
    workflows.find((w) => w.workflowId === defaultWorkflowId) ??
    workflows.find((w) => !w.workflowScopes.length);
  return match && { codename: match.workflowCodename, name: match.workflowName };
};

/**
 * Whether the toolkit can archive a variant in this workflow: it saves the variant in the workflow's first
 * step and then moves it straight to Archived, which the workflow's transitions must allow.
 */
export const canArchiveFromFirstStep = (steps: WorkflowSteps, workflowCodename: string): boolean => {
  const inWorkflow = [...steps.values()].filter((s) => s.workflowCodename === workflowCodename);
  const first = inWorkflow.find((s) => s.kind === "draft");
  const archived = inWorkflow.find((s) => s.kind === "archived");
  return !!first && !!archived && first.transitionsTo.includes(archived.id);
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
  /** The target step the latest version lands in when it is a draft (after any step fallback). */
  readonly latestStepName: string;
  /** The target step "Copy as drafts" puts published, scheduled and archived versions in. */
  readonly firstStepName: string;
}): Prediction =>
  params.mode === "drafts"
    ? predictDrafts(params)
    : { outcome: describeSource(params.source, params.latestStepName), effects: matchEffects(params) };

/** In "match" mode the target ends up in the source's state. */
const describeSource = (source: PublishingState, latestStepName: string): string => {
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
        ? `Published, with a newer draft in ${stepLabel(latestStepName)}`
        : `Not published, in ${stepLabel(latestStepName)}`;
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
  latestStepName,
  firstStepName,
}: {
  source: PublishingState;
  target: PublishingState | undefined;
  latestStepName: string;
  firstStepName: string;
}): Prediction => {
  // Archived stays archived; the preview blocks the case where that would take a live target version offline.
  if (source.stepKind === "archived") return { outcome: "Archived", effects: [] };
  const draftStep = stepLabel(source.stepKind === "draft" ? latestStepName : firstStepName);
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
