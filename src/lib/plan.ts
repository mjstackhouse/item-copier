import {
  type Connection,
  flattenTaxonomyTerms,
  flattenTypeElements,
  isNotFound,
  mapWithLimit,
  type SourceData,
  type TypeElementInfo,
} from "./kontent";
import { expandWithLinkedItems, type PlannedItem } from "./linkedItems";
import {
  canArchiveFromFirstStep,
  findStep,
  firstSteps,
  requiredWorkflow,
  targetStepFor,
  type WorkflowStepInfo,
  getPublishingState,
  loadWorkflowSteps,
  type PublishingState,
  type PublishMode,
  type VariantState,
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
  /** The workflow the variant goes to in the target: the source's, or the one the target's scopes require. */
  readonly targetWorkflowCodename: string;
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

  const [targetLanguages, targetTypes, targetSteps, targetCollections, targetSnippets, targetTaxonomies] =
    await Promise.all([
      target.client.listLanguages().toAllPromise(),
      target.client.listContentTypes().toAllPromise(),
      loadWorkflowSteps(target.client),
      target.client.listCollections().toPromise(),
      target.client.listContentTypeSnippets().toAllPromise(),
      target.client.listTaxonomies().toAllPromise(),
    ]);
  const targetSnippetsById = new Map(targetSnippets.data.items.map((s) => [s.id, s]));
  const targetElementsByType = new Map(
    targetTypes.data.items.map((t) => [t.codename, flattenTypeElements(t.elements, targetSnippetsById)]),
  );

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
    ...checkElements(sourceData, known, targetElementsByType),
    ...checkTaxonomyTerms(
      sourceData,
      known,
      flattenTaxonomyTerms(targetTaxonomies.data.items),
      new Set(targetTaxonomies.data.items.map((g) => g.codename)),
    ),
  );
  // The workflow each variant goes to in the target. A workflow missing in the target is blocked above;
  // otherwise the target's workflow scopes decide, which usually means the source's workflow.
  const targetWorkflowNames = new Set([...targetSteps.values()].map((s) => s.workflowCodename));
  const targetTypeIds = new Map(targetTypes.data.items.map((t) => [t.codename, t.id]));
  const targetCollectionIds = new Map(targetCollections.data.collections.map((c) => [c.codename, c.id]));
  const targetWorkflowOf = (p: PlannedItem): string => {
    const step = findStep(sourceData.workflowSteps, p.state);
    if (!step) return "";
    if (!targetWorkflowNames.has(step.workflowCodename)) return step.workflowCodename;
    const required = requiredWorkflow(
      targetSteps,
      targetTypeIds.get(sourceData.typesById.get(p.item.typeId)?.codename ?? "") ?? "",
      targetCollectionIds.get(sourceData.collectionCodenames.get(p.item.collectionId) ?? "") ?? "",
    );
    return required?.codename ?? step.workflowCodename;
  };
  blockers.push(...checkArchiving(sourceData.workflowSteps, targetSteps, known, targetWorkflowOf));
  const notes = describeWorkflowLanding(sourceData.workflowSteps, targetSteps, known, targetWorkflowOf);

  const sourceFirstSteps = firstSteps(sourceData.workflowSteps);

  params.onProgress(
    `Checking publishing state and which of the ${known.length} language variants already exist in the target`,
  );

  const targetVariants = await loadTargetVariants(
    target,
    known,
    new Map(targetLanguages.data.items.map((l) => [l.id, l.codename])),
  );
  // Two at a time: requests are paced anyway, and the Management API advises against parallel requests.
  const rows = await mapWithLimit(known, 2, async (planned): Promise<PlanRow> => {
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
      getTargetState(target, targetSteps, targetVariants, planned.item.codename, languageCodename),
    ]);
    return {
      ...planned,
      typeCodename,
      targetTypeCodename: targetState.typeId ? targetTypeCodenames.get(targetState.typeId) : undefined,
      targetStatus: targetState.status,
      sourcePublishing: sourceState,
      targetPublishing: targetState.publishing,
      targetWorkflowCodename: targetWorkflowOf(planned),
      ...landingSteps(sourceStep, sourceFirstSteps, targetSteps, targetWorkflowOf(planned)),
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

type TargetVariants = {
  /** Item codename -> its content type id in the target, or null when the target has no such item. */
  readonly itemTypes: ReadonlyMap<string, string | null>;
  /** "codename/language" -> the latest version's workflow and schedule, for variants that exist in the target. */
  readonly latest: ReadonlyMap<string, VariantState>;
};

const bulkGetLimit = 100;

/**
 * Looks up the planned variants in the target with as few requests as possible: one per item to see whether
 * it exists (a bulk request fails as a whole when any item in it doesn't exist), then one bulk request per
 * 100 variants of the items that do.
 */
const loadTargetVariants = async (
  target: Connection,
  planned: readonly PlannedItem[],
  /** The target's language id -> codename; bulk responses refer to languages by id. */
  languageCodenames: ReadonlyMap<string, string>,
): Promise<TargetVariants> => {
  const codenames = unique(planned.map((p) => p.item.codename));
  const types = await mapWithLimit(codenames, 2, async (codename) => {
    try {
      return (await target.client.viewContentItem().byItemCodename(codename).toPromise()).data.type.id ?? "";
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  });
  const itemTypes = new Map(codenames.map((codename, i) => [codename, types[i] ?? null]));

  const pairs = planned.filter((p) => itemTypes.get(p.item.codename) !== null);
  const latest = new Map<string, VariantState>();
  for (let start = 0; start < pairs.length; start += bulkGetLimit) {
    const chunk = pairs.slice(start, start + bulkGetLimit);
    const response = await target.client
      .bulkGetItemsWithVariants()
      .withData({
        variants: chunk.map((p) => ({ item: { codename: p.item.codename }, language: { codename: p.languageCodename } })),
      })
      .toAllPromise();
    for (const { item, variant } of response.data.items) {
      const languageCodename = variant && languageCodenames.get(variant.language.id ?? "");
      if (!variant || !languageCodename) continue;
      latest.set(`${item.codename}/${languageCodename}`, {
        workflowId: variant.workflow.workflow_identifier.id ?? "",
        stepId: variant.workflow.step_identifier.id ?? "",
        publishTime: variant.schedule?.publish_time ?? null,
        unpublishTime: variant.schedule?.unpublish_time ?? null,
      });
    }
  }
  return { itemTypes, latest };
};

const getTargetState = async (
  target: Connection,
  steps: WorkflowSteps,
  variants: TargetVariants,
  codename: string,
  languageCodename: string,
): Promise<{ readonly status: TargetStatus; readonly typeId?: string; readonly publishing?: PublishingState }> => {
  const typeId = variants.itemTypes.get(codename);
  if (typeId === null || typeId === undefined) return { status: "new item" };
  const latest = variants.latest.get(`${codename}/${languageCodename}`);
  if (!latest) return { status: "new language variant", typeId };

  const publishing = await getPublishingState({ client: target.client, steps, item: { codename }, languageCodename, latest });
  return { status: "overwrites existing", typeId, publishing };
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
 * Where variants land when it isn't the same workflow and step as in the source: a different workflow because
 * the target's workflow scopes require it for their content type and collection (for example an older item
 * that stayed in the default workflow after a scope was added), or a different step because the target's
 * workflow lacks theirs (for example a step added after the environment was cloned). The copy moves them
 * (see `fitStepsToTarget` in copy.ts); the preview says so.
 */
const describeWorkflowLanding = (
  sourceSteps: WorkflowSteps,
  targetSteps: WorkflowSteps,
  items: readonly PlannedItem[],
  targetWorkflowOf: (p: PlannedItem) => string,
): string[] => {
  const moves = new Map<string, { from: WorkflowStepInfo; to: WorkflowStepInfo; items: PlannedItem[] }>();
  for (const p of items) {
    const from = findStep(sourceSteps, p.state);
    const to = from && targetStepFor(targetSteps, targetWorkflowOf(p), from);
    if (!from || !to || (to.workflowCodename === from.workflowCodename && to.codename === from.codename)) continue;
    const key = `${from.workflowCodename}/${from.codename}>${to.workflowCodename}/${to.codename}`;
    const move = moves.get(key) ?? { from, to, items: [] };
    move.items.push(p);
    moves.set(key, move);
  }
  return [...moves.values()].map(({ from, to, items: moved }) =>
    to.workflowCodename !== from.workflowCodename
      ? `In the target, the workflow scopes require the "${to.workflowName}" workflow for these items' content type and collection, so ${moved.length} variant(s) in the "${from.workflowName}" workflow will go to its "${to.name}" step instead: ${namesOf(moved)}.`
      : `The target's "${from.workflowName}" workflow has no "${from.name}" step, so ${moved.length} variant(s) in it will go to its "${to.name}" step instead: ${namesOf(moved)}.`,
  );
};

/**
 * Archiving is a deliberate decision, so archived items are only copied as archived. The toolkit saves the
 * variant in the workflow's first step and then moves it to Archived; when the target's workflow doesn't
 * allow that move, the copy is blocked rather than leaving the item as a draft.
 */
const checkArchiving = (
  sourceSteps: WorkflowSteps,
  targetSteps: WorkflowSteps,
  items: readonly PlannedItem[],
  targetWorkflowOf: (p: PlannedItem) => string,
): string[] => {
  const targetWorkflows = new Set([...targetSteps.values()].map((s) => s.workflowCodename));
  const stuck = new Map<string, PlannedItem[]>();
  for (const p of items) {
    if (findStep(sourceSteps, p.state)?.kind !== "archived") continue;
    const workflow = targetWorkflowOf(p);
    // A workflow missing in the target is reported by the workflow check.
    if (!targetWorkflows.has(workflow) || canArchiveFromFirstStep(targetSteps, workflow)) continue;
    stuck.set(workflow, [...(stuck.get(workflow) ?? []), p]);
  }
  return [...stuck.entries()].map(([workflow, archived]) => {
    const steps = [...targetSteps.values()].filter((s) => s.workflowCodename === workflow);
    const first = steps.find((s) => s.kind === "draft");
    return `These items are archived in the source, but in the target's "${steps[0]?.workflowName ?? workflow}" workflow the first step ("${first?.name ?? "?"}") can't move to Archived, so they can't be copied as archived: ${namesOf(archived)}. Allow that move in the target's workflow, or leave these items out (for linked items, lower the linked items depth).`;
  });
};

/** Where the variant's versions land in the target, for the preview's predictions. */
const landingSteps = (
  sourceStep: WorkflowStepInfo | undefined,
  sourceFirstSteps: ReadonlyMap<string, WorkflowStepInfo>,
  targetSteps: WorkflowSteps,
  targetWorkflow: string,
): { readonly latestStepName: string; readonly firstStepName: string } => {
  if (!sourceStep) return { latestStepName: "", firstStepName: "" };
  const sourceFirst = sourceFirstSteps.get(sourceStep.workflowCodename);
  return {
    latestStepName: (targetStepFor(targetSteps, targetWorkflow, sourceStep) ?? sourceStep).name,
    firstStepName: sourceFirst ? (targetStepFor(targetSteps, targetWorkflow, sourceFirst) ?? sourceFirst).name : "",
  };
};

/**
 * The toolkit writes each element by codename into the target's content type of the same codename, and fails
 * the variant when the element is missing there or holds a different kind of value. Extra elements in the
 * target are fine.
 */
const checkElements = (
  sourceData: SourceData,
  items: readonly PlannedItem[],
  targetElementsByType: ReadonlyMap<string, readonly TypeElementInfo[]>,
): string[] =>
  unique(items.map((p) => p.item.typeId)).flatMap((typeId) => {
    const type = sourceData.typesById.get(typeId);
    const targetElements = type && targetElementsByType.get(type.codename);
    // A content type missing in the target is reported by the content type check.
    if (!type || !targetElements) return [];
    const targetTypes = new Map(targetElements.map((e) => [e.codename, e.type]));
    const problems = (sourceData.typeElements.get(typeId) ?? []).flatMap((e) => {
      const targetType = targetTypes.get(e.codename);
      if (!targetType) return [`it has no "${e.name}" element (codename ${e.codename})`];
      if (targetType !== e.type) {
        return [
          `its "${e.name}" element (codename ${e.codename}) is ${elementTypeLabel(targetType)}, not ${elementTypeLabel(e.type)} as in the source`,
        ];
      }
      return [];
    });
    if (!problems.length) return [];
    const affected = items.filter((p) => p.item.typeId === typeId);
    return [
      `The target's "${type.name}" content type doesn't match the source: ${problems.join("; ")}. It is used by: ${namesOf(affected)}. Update the content type in the target (for example with data-ops sync), then preview again.`,
    ];
  });

const elementTypeLabels: Record<string, string> = {
  modular_content: "a linked items element",
  subpages: "a subpages element",
  rich_text: "a rich text element",
  url_slug: "a URL slug element",
  date_time: "a date & time element",
  multiple_choice: "a multiple choice element",
  custom: "a custom element",
  asset: "an asset element",
};

const elementTypeLabel = (type: string) => elementTypeLabels[type] ?? `a ${type} element`;

/** The toolkit writes taxonomy terms by codename; a term missing in the target fails the variant. */
const checkTaxonomyTerms = (
  sourceData: SourceData,
  items: readonly PlannedItem[],
  targetTerms: ReadonlyMap<string, { readonly codename: string; readonly groupCodename: string }>,
  targetGroups: ReadonlySet<string>,
): string[] => {
  const targetKeys = new Set([...targetTerms.values()].map((t) => `${t.groupCodename}/${t.codename}`));
  // Group codename -> missing terms, and the items that use them.
  const missing = new Map<string, { groupName: string; terms: Set<string>; items: PlannedItem[] }>();
  for (const p of items) {
    for (const termId of p.termIds) {
      const term = sourceData.taxonomyTerms.get(termId);
      if (!term || targetKeys.has(`${term.groupCodename}/${term.codename}`)) continue;
      const entry = missing.get(term.groupCodename) ?? { groupName: term.groupName, terms: new Set(), items: [] };
      entry.terms.add(term.name);
      if (!entry.items.includes(p)) entry.items.push(p);
      missing.set(term.groupCodename, entry);
    }
  }
  return [...missing.entries()].map(([groupCodename, { groupName, terms, items: affected }]) =>
    targetGroups.has(groupCodename)
      ? `The target's "${groupName}" taxonomy group is missing these terms: ${[...terms].join(", ")}. They are used by: ${namesOf(affected)}. Add the terms in the target (for example with data-ops sync), then preview again.`
      : `The target has no "${groupName}" taxonomy group (codename ${groupCodename}), whose terms are used by: ${namesOf(affected)}. Add it in the target (for example with data-ops sync), then preview again.`,
  );
};

/**
 * Blockers that depend on the publishing option, which can change after the preview is built.
 * "Copy as drafts" keeps archived items archived, but archiving a variant that is live in the target
 * would take it offline, which that option promises not to do.
 */
export const publishModeBlockers = (plan: Plan, mode: PublishMode, targetEnvironmentName: string): string[] => {
  if (mode !== "drafts") return [];
  const archivedOverLive = plan.rows.filter(
    (r) => r.sourcePublishing?.stepKind === "archived" && r.targetPublishing?.hasPublishedVersion,
  );
  return archivedOverLive.length
    ? [
        `These items are archived in the source but live in ${targetEnvironmentName}. Copying them as archived would take them offline, which "Copy as drafts" doesn't do: ${[...new Set(archivedOverLive.map((r) => r.item.name))].join(", ")}. Choose "Match the source", or leave these items out.`,
      ]
    : [];
};
