import { type Connection, isNotFound, mapWithLimit, type SourceData } from "./kontent";
import { expandWithLinkedItems, type PlannedItem } from "./linkedItems";
import {
  firstSteps,
  getPublishingState,
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
  /** Publishing state of the source variant; the preview predicts the outcome from it for the chosen mode. */
  readonly sourcePublishing?: PublishingState;
  /** Publishing state of the existing target variant; undefined when the target has none. */
  readonly targetPublishing?: PublishingState;
  /** First step of the item's workflow, where copied drafts can land. */
  readonly firstStepName: string;
};

export type Plan = {
  readonly rows: readonly PlanRow[];
  /** Problems that stop the copy from running. */
  readonly blockers: readonly string[];
  /** Things the user should know but that do not stop the copy. */
  readonly warnings: readonly string[];
  /**
   * References to items that no longer exist in the source. The toolkit fails the copy on them unless
   * it is told to skip them, which the preview asks for.
   */
  readonly deletedReferenceCount: number;
  /** Variants skipped because the item has no variant in that language in the source. Not a problem, just information. */
  readonly skippedVariants: readonly { readonly itemId: string; readonly itemName: string; readonly languageCodename: string }[];
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
  /** The languages to copy; each item is copied in those of them it has a variant in. */
  readonly languageCodenames: readonly string[];
  readonly linkedItemsDepth: number;
  readonly onProgress: (message: string) => void;
}): Promise<Plan> => {
  const { source, target, sourceData, languageCodenames } = params;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const linked = await expandWithLinkedItems({
    client: source.client,
    pickedIds: params.pickedIds,
    languageCodenames,
    maxDepth: params.linkedItemsDepth,
    elementTypes: sourceData.elementTypes,
    onProgress: params.onProgress,
  });

  const pickedSet = new Set(params.pickedIds);
  const copiedIds = new Set(linked.items.map((p) => p.id));
  const pickedDeleted = linked.deletedIds.filter((id) => pickedSet.has(id));
  const deletedReferences = linked.deletedIds.filter((id) => !pickedSet.has(id));
  const pickedInNoLanguage = unique(
    linked.withoutVariant.filter((w) => w.picked && !copiedIds.has(w.item.id)).map((w) => w.item.name),
  );
  // Variants that are skipped because the item has no variant in that language.
  const skippedVariants = linked.withoutVariant.filter((w) => copiedIds.has(w.item.id) || !w.picked);

  if (pickedDeleted.length) {
    blockers.push(`${pickedDeleted.length} selected item(s) no longer exist in the source. Go back and remove them.`);
  }
  if (pickedInNoLanguage.length) {
    blockers.push(
      `These selected items have a variant in none of the chosen languages: ${pickedInNoLanguage.join(", ")}. Remove them or choose other languages.`,
    );
  }

  params.onProgress("Checking the target environment");

  const [targetLanguages, targetTypes, targetSteps, targetCollections] = await Promise.all([
    target.client.listLanguages().toAllPromise(),
    target.client.listContentTypes().toAllPromise(),
    loadWorkflowSteps(target.client),
    target.client.listCollections().toPromise(),
  ]);

  for (const languageCodename of languageCodenames) {
    const targetLanguage = targetLanguages.data.items.find((l) => l.codename === languageCodename);
    if (!targetLanguage) {
      blockers.push(`The target has no language with the codename "${languageCodename}".`);
    } else if (!targetLanguage.isActive) {
      blockers.push(`The language "${languageCodename}" is not active in the target.`);
    }
  }

  const known = linked.items;

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

  const sourceFirstSteps = firstSteps(sourceData.workflowSteps);

  params.onProgress(
    `Checking publishing state and which of the ${known.length} language variants already exist in the target`,
  );

  const targetItemTypes = new Map<string, Promise<string | undefined | null>>();
  const rows = await mapWithLimit(known, 5, async (planned): Promise<PlanRow> => {
    const { languageCodename } = planned;
    const typeCodename = sourceData.typesById.get(planned.item.typeId)?.codename ?? "";
    const sourceStep = planned.state && sourceData.workflowSteps.get(planned.state.stepId);
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
      getTargetState(target, targetSteps, targetItemTypes, planned.item.codename, languageCodename),
    ]);
    return {
      ...planned,
      typeCodename,
      targetTypeCodename: targetState.typeId ? targetTypeCodenames.get(targetState.typeId) : undefined,
      targetStatus: targetState.status,
      sourcePublishing: sourceState,
      targetPublishing: targetState.publishing,
      firstStepName: (sourceStep && sourceFirstSteps.get(sourceStep.workflowCodename)?.name) ?? "",
    };
  });

  const typeMismatches = unique(
    rows
      .filter((r) => r.targetTypeCodename && r.targetTypeCodename !== r.typeCodename)
      .map((r) => `${r.item.name} (${r.typeCodename} in the source, ${r.targetTypeCodename} in the target)`),
  );
  if (typeMismatches.length) {
    blockers.push(
      `These items already exist in the target with a different content type, which the copy can't change: ${typeMismatches.join(", ")}. Remove them from the copy, or delete or rename the target items first.`,
    );
  }

  // Group each item's variants together, items in the order they were found, languages in the chosen order.
  const minDepth = new Map<string, number>();
  for (const r of rows) minDepth.set(r.id, Math.min(minDepth.get(r.id) ?? r.depth, r.depth));
  const languageOrder = (codename: string) => languageCodenames.indexOf(codename);
  rows.sort(
    (a, b) =>
      (minDepth.get(a.id) ?? 0) - (minDepth.get(b.id) ?? 0) ||
      a.item.name.localeCompare(b.item.name) ||
      a.id.localeCompare(b.id) ||
      languageOrder(a.languageCodename) - languageOrder(b.languageCodename),
  );

  return {
    rows,
    blockers,
    warnings,
    deletedReferenceCount: deletedReferences.length,
    skippedVariants: skippedVariants.map((w) => ({
      itemId: w.item.id,
      itemName: w.item.name,
      languageCodename: w.languageCodename,
    })),
  };
};

/**
 * `itemTypes` caches the target item lookup per codename (null: not in the target), so an item
 * copied in several languages is looked up once.
 */
const getTargetState = async (
  target: Connection,
  steps: WorkflowSteps,
  itemTypes: Map<string, Promise<string | undefined | null>>,
  codename: string,
  languageCodename: string,
): Promise<{ readonly status: TargetStatus; readonly typeId?: string; readonly publishing?: PublishingState }> => {
  if (!itemTypes.has(codename)) {
    itemTypes.set(
      codename,
      target.client
        .viewContentItem()
        .byItemCodename(codename)
        .toPromise()
        .then((r) => r.data.type.id)
        .catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        }),
    );
  }
  const typeId = await itemTypes.get(codename);
  if (typeId === null) return { status: "new item" };

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

const namesOf = (items: readonly PlannedItem[]) => unique(items.map((p) => p.item.name)).join(", ");

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
