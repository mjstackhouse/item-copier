import type { ManagementClient } from "@kontent-ai/management-sdk";

import { isNotFound } from "./kontent";

export type StepKind = "draft" | "published" | "archived" | "scheduled";

/** Workflow step id -> step name and what kind of step it is, across all workflows. */
export type WorkflowSteps = ReadonlyMap<string, { readonly name: string; readonly kind: StepKind }>;

/** The latest version of a variant: its workflow step and schedule. */
export type VariantState = {
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
export type LiveEffect = "goes live" | "replaces live content" | "removed from live site" | "schedule replaced";

export const loadWorkflowSteps = async (client: ManagementClient): Promise<WorkflowSteps> => {
  const workflows = (await client.listWorkflows().toPromise()).data;
  const steps = new Map<string, { name: string; kind: StepKind }>();

  for (const workflow of workflows) {
    for (const step of workflow.steps) steps.set(step.id, { name: step.name, kind: "draft" });
    steps.set(workflow.publishedStep.id, { name: workflow.publishedStep.name, kind: "published" });
    steps.set(workflow.archivedStep.id, { name: workflow.archivedStep.name, kind: "archived" });
    if (workflow.scheduledStep) {
      steps.set(workflow.scheduledStep.id, { name: workflow.scheduledStep.name, kind: "scheduled" });
    }
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
  const step = params.steps.get(params.latest.stepId) ?? { name: "Unknown step", kind: "draft" as const };

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

/** Describes the state the item will be in, in the target, after the copy. */
export const describeOutcome = (source: PublishingState): string => {
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
        ? `Published, with a newer draft in the ${source.stepName} step`
        : `Not published, in the ${source.stepName} step`;
  }
};

/** Works out how the copy changes what is live in the target. `target` is undefined when the target has no variant yet. */
export const getLiveEffects = (source: PublishingState, target: PublishingState | undefined): LiveEffect[] => {
  const effects: LiveEffect[] = [];
  const targetLive = target?.hasPublishedVersion ?? false;

  if (source.hasPublishedVersion) effects.push(targetLive ? "replaces live content" : "goes live");
  else if (targetLive) effects.push("removed from live site");

  // The toolkit cancels any schedule in the target before copying, then applies the source's.
  if (target?.publishTime || target?.unpublishTime) effects.push("schedule replaced");

  return effects;
};

const formatTime = (iso: string) =>
  `on ${new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
