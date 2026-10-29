import { type Connection, isNotFound, mapWithLimit, type SourceData } from "./kontent";
import { expandWithLinkedItems, type PlannedItem } from "./linkedItems";
import {
  describeOutcome,
  getLiveEffects,
  getPublishingState,
  type LiveEffect,
  loadWorkflowSteps,
  type PublishingState,
  type WorkflowSteps,
} from "./publishing";

export type TargetStatus = "new item" | "new language variant" | "overwrites existing";

export type PlanRow = PlannedItem & {
  readonly typeCodename: string;
  readonly targetStatus: TargetStatus;
  /** Content type of the existing target item; undefined when the item is new to the target. */
  readonly targetTypeCodename?: string;
  /** The state the item will be in, in the target, after the copy. */
  readonly outcome: string;
  /** How the copy changes what is live in the target for this item. */
  readonly effects: readonly LiveEffect[];
};

export type Plan = {
  readonly rows: readonly PlanRow[];
  /** Problems that stop the copy from running. */
  readonly blockers: readonly string[];
  /** Things the user should know but that do not stop the copy. */
  readonly warnings: readonly string[];
};

/**
 * Works out exactly what will be copied and checks it against the target:
 * linked items, whether each item already exists there, and whether the target has the
 * language and content types the items need.
 */
export const buildPlan = async (params: {
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly pickedIds: readonly string[];
  readonly languageCodename: string;
  readonly linkedItemsDepth: number;
  readonly skipMissingReferences: boolean;
  readonly onProgress: (message: string) => void;
}): Promise<Plan> => {
  const { source, target, sourceData, languageCodename } = params;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const linked = await expandWithLinkedItems({
    client: source.client,
    pickedIds: params.pickedIds,
    languageCodename,
    maxDepth: params.linkedItemsDepth,
    elementTypes: sourceData.elementTypes,
    onProgress: params.onProgress,
  });

  const pickedSet = new Set(params.pickedIds);
  const pickedWithoutVariant = linked.withoutVariant.filter((i) => pickedSet.has(i.id));
  const linkedWithoutVariant = linked.withoutVariant.filter((i) => !pickedSet.has(i.id));
  const pickedDeleted = linked.deletedIds.filter((id) => pickedSet.has(id));
  const deletedReferences = linked.deletedIds.filter((id) => !pickedSet.has(id));

  if (pickedDeleted.length) {
    blockers.push(`${pickedDeleted.length} selected item(s) no longer exist in the source. Go back and remove them.`);
  }
  if (pickedWithoutVariant.length) {
    blockers.push(
      `These items have no "${languageCodename}" variant in the source: ${pickedWithoutVariant.map((i) => i.name).join(", ")}. Remove them or pick another language.`,
    );
  }
  if (linkedWithoutVariant.length) {
    warnings.push(
      `${linkedWithoutVariant.length} linked item(s) have no "${languageCodename}" variant and will not be copied: ${linkedWithoutVariant.map((i) => i.name).join(", ")}.`,
    );
  }

  if (deletedReferences.length && !params.skipMissingReferences) {
    warnings.push(
      `${deletedReferences.length} reference(s) point to items that no longer exist in the source. Turn on "Skip references to deleted items" or the copy will fail.`,
    );
  }

  params.onProgress("Checking the target environment");

  const [targetLanguages, targetTypes, targetSteps, targetCollections] = await Promise.all([
    target.client.listLanguages().toAllPromise(),
    target.client.listContentTypes().toAllPromise(),
    loadWorkflowSteps(target.client),
    target.client.listCollections().toPromise(),
  ]);

  const targetLanguage = targetLanguages.data.items.find((l) => l.codename === languageCodename);
  if (!targetLanguage) {
    blockers.push(`The target has no language with the codename "${languageCodename}".`);
  } else if (!targetLanguage.isActive) {
    blockers.push(`The language "${languageCodename}" is not active in the target.`);
  }

  // Picked items without a variant are already blockers; leave them out of the table.
  const withoutVariantIds = new Set(linked.withoutVariant.map((i) => i.id));
  const known = linked.items.filter((p) => !withoutVariantIds.has(p.id));

  const targetTypeCodenames = new Map(targetTypes.data.items.map((t) => [t.id, t.codename]));
  const targetTypeCodenameSet = new Set(targetTypeCodenames.values());
  const missingTypes = [
    ...new Set(
      known
        .map(({ item }) => sourceData.typesById.get(item.typeId)?.codename ?? "")
        .filter((codename) => codename && !targetTypeCodenameSet.has(codename)),
    ),
  ];
  if (missingTypes.length) {
    blockers.push(
      `The target is missing these content types: ${missingTypes.join(", ")}. Sync the content model first (for example with data-ops sync).`,
    );
  }

  blockers.push(
    ...checkTaxonomyGroups(sourceData, known),
    ...checkCollections(sourceData, known, new Set(targetCollections.data.collections.map((c) => c.codename))),
    ...checkWorkflows(sourceData.workflowSteps, targetSteps, known),
  );

  params.onProgress(`Checking publishing state and which of the ${known.length} items already exist in the target`);

  const rows = await mapWithLimit(known, 5, async (planned): Promise<PlanRow> => {
    const typeCodename = sourceData.typesById.get(planned.item.typeId)?.codename ?? "";
    const [sourceState, targetState] = await Promise.all([
      planned.state
        ? getPublishingState({
            client: source.client,
            steps: sourceData.workflowSteps,
            item: { id: planned.id },
            languageCodename,
            latest: planned.state,
          })
        : undefined,
      getTargetState(target, targetSteps, planned.item.codename, languageCodename),
    ]);
    return {
      ...planned,
      typeCodename,
      targetTypeCodename: targetState.typeId ? targetTypeCodenames.get(targetState.typeId) : undefined,
      targetStatus: targetState.status,
      outcome: sourceState ? describeOutcome(sourceState) : "",
      effects: sourceState ? getLiveEffects(sourceState, targetState.publishing) : [],
    };
  });

  const typeMismatches = rows.filter((r) => r.targetTypeCodename && r.targetTypeCodename !== r.typeCodename);
  if (typeMismatches.length) {
    blockers.push(
      `These items already exist in the target with a different content type, which the copy can't change: ${typeMismatches
        .map((r) => `${r.item.name} (${r.typeCodename} in the source, ${r.targetTypeCodename} in the target)`)
        .join(", ")}. Remove them from the copy, or delete or rename the target items first.`,
    );
  }

  return { rows: rows.sort((a, b) => a.depth - b.depth || a.item.name.localeCompare(b.item.name)), blockers, warnings };
};

const getTargetState = async (
  target: Connection,
  steps: WorkflowSteps,
  codename: string,
  languageCodename: string,
): Promise<{ readonly status: TargetStatus; readonly typeId?: string; readonly publishing?: PublishingState }> => {
  let typeId: string | undefined;
  try {
    typeId = (await target.client.viewContentItem().byItemCodename(codename).toPromise()).data.type.id;
  } catch (error) {
    if (isNotFound(error)) return { status: "new item" };
    throw error;
  }

  try {
    const variant = await target.client
      .viewLanguageVariant()
      .byItemCodename(codename)
      .byLanguageCodename(languageCodename)
      .toPromise();
    const publishing = await getPublishingState({
      client: target.client,
      steps,
      item: { codename },
      languageCodename,
      latest: {
        stepId: variant.data.workflow.stepIdentifier.id ?? "",
        publishTime: variant.data.schedule?.publishTime ?? null,
        unpublishTime: variant.data.schedule?.unpublishTime ?? null,
      },
    });
    return { status: "overwrites existing", typeId, publishing };
  } catch (error) {
    if (isNotFound(error)) return { status: "new language variant", typeId };
    throw error;
  }
};

const unique = (values: readonly string[]) => [...new Set(values)];

const namesOf = (items: readonly PlannedItem[]) => items.map((p) => p.item.name).join(", ");

/**
 * The toolkit looks up the taxonomy group of every taxonomy element while reading items, even when
 * no terms are selected, and fails the whole copy if the group no longer exists.
 */
const checkTaxonomyGroups = (sourceData: SourceData, items: readonly PlannedItem[]): string[] =>
  unique(items.map((p) => p.item.typeId)).flatMap((typeId) =>
    (sourceData.taxonomyElementsByType.get(typeId) ?? [])
      .filter((e) => !sourceData.taxonomyGroupIds.has(e.taxonomyGroupId))
      .map(
        (e) =>
          `The content type "${sourceData.typesById.get(typeId)?.name ?? typeId}" has a taxonomy element "${e.name}" that uses a taxonomy group that no longer exists in the source (id ${e.taxonomyGroupId}). The copy would fail. Point the element at an existing taxonomy group, or remove it, in both environments.`,
      ),
  );

/** The toolkit creates items in the collection with the same codename as in the source. */
const checkCollections = (
  sourceData: SourceData,
  items: readonly PlannedItem[],
  targetCollections: ReadonlySet<string>,
): string[] => {
  const missing = items.filter((p) => {
    const codename = sourceData.collectionCodenames.get(p.item.collectionId);
    return codename && !targetCollections.has(codename);
  });
  if (!missing.length) return [];
  const codenames = unique(missing.map((p) => sourceData.collectionCodenames.get(p.item.collectionId) ?? ""));
  return [
    `The target is missing these collections: ${codenames.join(", ")}. They are used by: ${namesOf(missing)}. Add the collections to the target first.`,
  ];
};

/** The toolkit puts each variant in the workflow and step with the same codenames as in the source. */
const checkWorkflows = (sourceSteps: WorkflowSteps, targetSteps: WorkflowSteps, items: readonly PlannedItem[]): string[] => {
  const targetWorkflows = new Set([...targetSteps.values()].map((s) => s.workflowCodename));
  const targetStepKeys = new Set([...targetSteps.values()].map((s) => `${s.workflowCodename}/${s.codename}`));
  const withStep = items.flatMap((p) => {
    const step = p.state && sourceSteps.get(p.state.stepId);
    return step ? [{ planned: p, step }] : [];
  });

  const missingWorkflow = withStep.filter(({ step }) => !targetWorkflows.has(step.workflowCodename));
  const missingStep = withStep.filter(
    ({ step }) => targetWorkflows.has(step.workflowCodename) && !targetStepKeys.has(`${step.workflowCodename}/${step.codename}`),
  );

  const blockers: string[] = [];
  if (missingWorkflow.length) {
    blockers.push(
      `The target is missing these workflows: ${unique(missingWorkflow.map(({ step }) => step.workflowName)).join(", ")}. They are used by: ${namesOf(missingWorkflow.map((w) => w.planned))}. Add the workflows to the target first (for example with data-ops sync).`,
    );
  }
  for (const key of unique(missingStep.map(({ step }) => `${step.workflowCodename}/${step.codename}`))) {
    const affected = missingStep.filter(({ step }) => `${step.workflowCodename}/${step.codename}` === key);
    const { step } = affected[0] as (typeof affected)[number];
    blockers.push(
      `The target's "${step.workflowName}" workflow has no "${step.name}" step (codename ${step.codename}). It is used by: ${namesOf(affected.map((a) => a.planned))}. Add the step in the target, or move the items to another step in the source.`,
    );
  }
  return blockers;
};
