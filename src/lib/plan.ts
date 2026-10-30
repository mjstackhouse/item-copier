import { type Connection, isNotFound, mapWithLimit, type SourceData } from "./kontent";
import { expandWithLinkedItems, type PlannedItem } from "./linkedItems";
import {
  findStep,
  firstSteps,
  targetStepFor,
  type WorkflowStepInfo,
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
  /** The target step the latest version lands in when it is a draft, after any step fallback. */
  readonly latestStepName: string;
  /** The target step "Copy as drafts" uses for published, scheduled and archived versions. */
  readonly firstStepName: string;
};

export type Plan = {
  readonly rows: readonly PlanRow[];
  /** Problems that stop the copy from running. */
  readonly blockers: readonly string[];
  /** Things the user should know but that do not stop the copy. */
  readonly warnings: readonly string[];
  /** Things worth knowing that are not a problem, such as steps the copy moves to another step. */
  readonly notes: readonly string[];
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
    ...checkMissingWorkflows(sourceData.workflowSteps, targetSteps, known),
  );
  const notes = describeStepFallbacks(sourceData.workflowSteps, targetSteps, known);

  const sourceFirstSteps = firstSteps(sourceData.workflowSteps);

  params.onProgress(
    `Checking publishing state and which of the ${known.length} language variants already exist in the target`,
  );

  const targetItemTypes = new Map<string, Promise<string | undefined | null>>();
  const rows = await mapWithLimit(known, 5, async (planned): Promise<PlanRow> => {
    const { languageCodename } = planned;
    const typeCodename = sourceData.typesById.get(planned.item.typeId)?.codename ?? "";
    const sourceStep = findStep(sourceData.workflowSteps, planned.state);
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
      ...landingSteps(sourceStep, sourceFirstSteps, targetSteps),
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
    notes,
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
        workflowId: variant.data.workflow.workflowIdentifier.id ?? "",
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

/**
 * The toolkit puts each variant in the workflow with the same codename as in the source. A missing workflow
 * blocks the copy: moving content into another workflow can change who may edit and publish it, so that is
 * the user's decision. A missing step doesn't block; see `describeStepFallbacks`.
 */
const checkMissingWorkflows = (
  sourceSteps: WorkflowSteps,
  targetSteps: WorkflowSteps,
  items: readonly PlannedItem[],
): string[] => {
  const targetWorkflows = new Set([...targetSteps.values()].map((s) => s.workflowCodename));
  const missing = items.flatMap((p) => {
    const step = findStep(sourceSteps, p.state);
    return step && !targetWorkflows.has(step.workflowCodename) ? [{ planned: p, step }] : [];
  });
  if (!missing.length) return [];
  return [
    `The target has no workflow with the codename ${unique(missing.map(({ step }) => `"${step.workflowCodename}" (${step.workflowName})`)).join(", ")}. It is used by: ${namesOf(missing.map((m) => m.planned))}. Create the workflow in the target with the same codename, or sync the workflows with data-ops sync, then preview again.`,
  ];
};

/**
 * Steps that exist in the source's workflow but not in the target's workflow of the same codename (for
 * example a step added after the environment was cloned). The copy moves those variants to the target
 * workflow's step of the same kind, or its first step, and the preview says so.
 */
const describeStepFallbacks = (
  sourceSteps: WorkflowSteps,
  targetSteps: WorkflowSteps,
  items: readonly PlannedItem[],
): string[] => {
  const moves = new Map<string, { from: WorkflowStepInfo; to: WorkflowStepInfo; items: PlannedItem[] }>();
  for (const p of items) {
    const from = findStep(sourceSteps, p.state);
    const to = from && targetStepFor(targetSteps, from.workflowCodename, from);
    if (!from || !to || to.codename === from.codename) continue;
    const key = `${from.workflowCodename}/${from.codename}`;
    const move = moves.get(key) ?? { from, to, items: [] };
    move.items.push(p);
    moves.set(key, move);
  }
  return [...moves.values()].map(
    ({ from, to, items: moved }) =>
      `The target's "${from.workflowName}" workflow has no "${from.name}" step, so ${moved.length} variant(s) in it will go to its "${to.name}" step instead: ${namesOf(moved)}.`,
  );
};

/** Where the variant's versions land in the target, for the preview's predictions. */
const landingSteps = (
  sourceStep: WorkflowStepInfo | undefined,
  sourceFirstSteps: ReadonlyMap<string, WorkflowStepInfo>,
  targetSteps: WorkflowSteps,
): { readonly latestStepName: string; readonly firstStepName: string } => {
  if (!sourceStep) return { latestStepName: "", firstStepName: "" };
  const workflow = sourceStep.workflowCodename;
  const sourceFirst = sourceFirstSteps.get(workflow);
  return {
    latestStepName: (targetStepFor(targetSteps, workflow, sourceStep) ?? sourceStep).name,
    firstStepName: sourceFirst ? (targetStepFor(targetSteps, workflow, sourceFirst) ?? sourceFirst).name : "",
  };
};
