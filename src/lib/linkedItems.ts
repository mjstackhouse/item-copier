import type { ManagementClient } from "@kontent-ai/management-sdk";

import { getItemsWithVariants, type Item, type VariantElement } from "./kontent";
import type { VariantState } from "./publishing";

/** One language variant of an item to copy. */
export type PlannedItem = {
  readonly id: string;
  readonly item: Item;
  readonly languageCodename: string;
  /** 0 for items the user picked, 1+ for items pulled in as linked items. */
  readonly depth: number;
  /** Id of the item that first linked to this one (undefined for picked items). */
  readonly linkedFrom?: string;
  /** Workflow step and schedule of the source variant. */
  readonly state: VariantState;
};

export type LinkedItemsResult = {
  /** Variants to copy: every item found, in every chosen language it has a variant in. */
  readonly items: readonly PlannedItem[];
  /** Items (picked or linked) without a variant in a chosen language; those variants are skipped. */
  readonly withoutVariant: readonly { readonly item: Item; readonly languageCodename: string; readonly picked: boolean }[];
  /** Ids that were referenced but no longer exist in the source. */
  readonly deletedIds: readonly string[];
};

// Rich text stores linked items as <object ... data-type="item" ... data-id="..."> and links
// to items as <a data-item-id="...">. Components use data-type="component" and are skipped here,
// because their contents are read from the element's `components` array instead.
const objectTagRegex = /<object\b[^>]*>/g;
const dataIdRegex = /data-id="([^"]+)"/;
const itemLinkRegex = /data-item-id="([^"]+)"/g;

/** Finds the ids of items referenced by a variant's elements, including inside rich-text components. */
export const findReferencedItemIds = (
  elements: readonly VariantElement[],
  elementTypes: ReadonlyMap<string, string>,
): Set<string> => {
  const ids = new Set<string>();

  for (const element of elements) {
    const type = element.element.id ? elementTypes.get(element.element.id) : undefined;

    // Subpages elements store references the same way as linked-items elements.
    if ((type === "modular_content" || type === "subpages") && Array.isArray(element.value)) {
      for (const ref of element.value as { id?: string }[]) {
        if (ref.id) ids.add(ref.id);
      }
    }

    if (type === "rich_text" && typeof element.value === "string") {
      for (const tag of element.value.match(objectTagRegex) ?? []) {
        const id = tag.includes('data-type="item"') ? dataIdRegex.exec(tag)?.[1] : undefined;
        if (id) ids.add(id);
      }
      for (const match of element.value.matchAll(itemLinkRegex)) {
        if (match[1]) ids.add(match[1]);
      }
      for (const component of element.components ?? []) {
        for (const id of findReferencedItemIds(component.elements, elementTypes)) ids.add(id);
      }
    }
  }

  return ids;
};

/**
 * Starting from the picked items, follows linked items and rich-text references breadth first,
 * up to `maxDepth` levels, separately in each language: translations can link to different items.
 * With maxDepth 0 it returns just the picked items. Each level is loaded with bulk requests
 * (up to 100 items each).
 */
export const expandWithLinkedItems = async (params: {
  readonly client: ManagementClient;
  readonly pickedIds: readonly string[];
  readonly languageCodenames: readonly string[];
  readonly maxDepth: number;
  readonly elementTypes: ReadonlyMap<string, string>;
  readonly onProgress?: (message: string) => void;
}): Promise<LinkedItemsResult> => {
  const results: LinkedItemsResult[] = [];
  // One language at a time: the Management API advises against parallel requests.
  for (const languageCodename of params.languageCodenames) {
    results.push(await expandInLanguage({ ...params, languageCodename }));
  }
  return {
    items: results.flatMap((r) => r.items),
    withoutVariant: results.flatMap((r) => r.withoutVariant),
    deletedIds: [...new Set(results.flatMap((r) => r.deletedIds))],
  };
};

const expandInLanguage = async (params: {
  readonly client: ManagementClient;
  readonly pickedIds: readonly string[];
  readonly languageCodename: string;
  readonly maxDepth: number;
  readonly elementTypes: ReadonlyMap<string, string>;
  readonly onProgress?: (message: string) => void;
}): Promise<LinkedItemsResult> => {
  const planned: PlannedItem[] = [];
  const withoutVariant: { item: Item; languageCodename: string; picked: boolean }[] = [];
  const deletedIds: string[] = [];
  const seen = new Set(params.pickedIds);
  const { languageCodename } = params;
  let frontier: { readonly id: string; readonly linkedFrom?: string }[] = params.pickedIds.map((id) => ({ id }));

  for (let depth = 0; frontier.length > 0; depth++) {
    params.onProgress?.(
      depth === 0
        ? `Loading the selected items (${languageCodename})`
        : `Looking for linked items in ${languageCodename}, level ${depth} (${frontier.length} items)`,
    );

    const found = await getItemsWithVariants(
      params.client,
      frontier.map((f) => f.id),
      languageCodename,
    );

    const nextFrontier: { id: string; linkedFrom: string }[] = [];
    for (const { id, linkedFrom } of frontier) {
      const entry = found.get(id);
      if (!entry) {
        deletedIds.push(id);
        continue;
      }
      if (!entry.elements || !entry.state) {
        // Skipped in this language. Linked items keep being referenced by external id, so the
        // links connect if the variant is copied later.
        withoutVariant.push({ item: entry.item, languageCodename, picked: depth === 0 });
        continue;
      }

      planned.push({ id, item: entry.item, languageCodename, depth, linkedFrom, state: entry.state });
      if (depth < params.maxDepth) {
        for (const refId of findReferencedItemIds(entry.elements, params.elementTypes)) {
          if (!seen.has(refId)) {
            seen.add(refId);
            nextFrontier.push({ id: refId, linkedFrom: id });
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  return { items: planned, withoutVariant, deletedIds };
};
