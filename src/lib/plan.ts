import { type Connection, isNotFound, mapWithLimit, type SourceData } from "./kontent";
import { expandWithLinkedItems, type PlannedItem } from "./linkedItems";

export type TargetStatus = "new item" | "new language variant" | "overwrites existing";

export type PlanRow = PlannedItem & {
  readonly typeCodename: string;
  readonly targetStatus: TargetStatus;
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

  const [targetLanguages, targetTypes] = await Promise.all([
    target.client.listLanguages().toAllPromise(),
    target.client.listContentTypes().toAllPromise(),
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

  const targetTypeCodenames = new Set(targetTypes.data.items.map((t) => t.codename));
  const missingTypes = [
    ...new Set(
      known
        .map(({ item }) => sourceData.typesById.get(item.typeId)?.codename ?? "")
        .filter((codename) => codename && !targetTypeCodenames.has(codename)),
    ),
  ];
  if (missingTypes.length) {
    blockers.push(
      `The target is missing these content types: ${missingTypes.join(", ")}. Sync the content model first (for example with data-ops sync).`,
    );
  }

  params.onProgress(`Checking which of the ${known.length} items already exist in the target`);

  const rows = await mapWithLimit(known, 5, async (planned): Promise<PlanRow> => {
    const typeCodename = sourceData.typesById.get(planned.item.typeId)?.codename ?? "";
    return { ...planned, typeCodename, targetStatus: await getTargetStatus(target, planned.item.codename, languageCodename) };
  });

  return { rows: rows.sort((a, b) => a.depth - b.depth || a.item.name.localeCompare(b.item.name)), blockers, warnings };
};

const getTargetStatus = async (target: Connection, codename: string, languageCodename: string): Promise<TargetStatus> => {
  try {
    await target.client.viewContentItem().byItemCodename(codename).toPromise();
  } catch (error) {
    if (isNotFound(error)) return "new item";
    throw error;
  }

  try {
    await target.client.viewLanguageVariant().byItemCodename(codename).byLanguageCodename(languageCodename).toPromise();
    return "overwrites existing";
  } catch (error) {
    if (isNotFound(error)) return "new language variant";
    throw error;
  }
};
