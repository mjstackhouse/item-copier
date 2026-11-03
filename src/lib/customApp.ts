import type { CustomAppContext as Context, SerializedListingFilter } from "@kontent-ai/custom-app-sdk";

import { type FilterContract, findItemIds, type Item, loadItems } from "./kontent";

/**
 * Running as a Kontent.ai custom app: the environment the app is opened in, and the optional JSON
 * settings from Environment settings > Custom apps. API keys are never read from the settings: Kontent.ai
 * advises against storing them there, and this tool's keys can create, edit and delete content.
 */
export type CustomAppSettings = {
  /** The environment the custom app is opened in. */
  readonly currentEnvironmentId: string;
  /** Environment IDs to fill in on the Connect step. */
  readonly sourceEnvironmentId?: string;
  readonly targetEnvironmentId?: string;
  /**
   * True in the "Dialog" display mode, where the items to copy are the ones selected in Kontent.ai and the
   * source is always the environment the app is opened in.
   */
  readonly dialog: boolean;
};

/** Custom apps run in an iframe inside app.kontent.ai; a standalone tab is its own top-level window. */
export const insideKontentAi = (): boolean => window.self !== window.top;

/**
 * Reads the settings, which may contain:
 * - `thisEnvironment`: "source" or "target", to fill that side with the environment the app is opened in
 * - `sourceEnvironmentId`, `targetEnvironmentId`: environment IDs for either side, for example the
 *   environment content is regularly copied to. They take precedence over `thisEnvironment`.
 * Anything else, including values of the wrong kind, is ignored. In a dialog, the source is always the
 * environment the app is opened in, so the settings can only fill in the target.
 */
export const parseCustomAppSettings = (
  currentEnvironmentId: string,
  appConfig: unknown,
  dialog = false,
): CustomAppSettings => {
  const config = appConfig && typeof appConfig === "object" ? (appConfig as Record<string, unknown>) : {};
  const id = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const side = config.thisEnvironment;

  if (dialog) {
    const target = id(config.targetEnvironmentId);
    return {
      currentEnvironmentId,
      sourceEnvironmentId: currentEnvironmentId,
      targetEnvironmentId: target === currentEnvironmentId ? undefined : target,
      dialog,
    };
  }
  return {
    currentEnvironmentId,
    sourceEnvironmentId: id(config.sourceEnvironmentId) ?? (side === "source" ? currentEnvironmentId : undefined),
    targetEnvironmentId: id(config.targetEnvironmentId) ?? (side === "target" ? currentEnvironmentId : undefined),
    dialog,
  };
};

/** What is selected in Kontent.ai, for the dialog. */
export type KontentSelection = {
  /** Where the user is: only these two pages have items to copy. */
  readonly page: "contentInventory" | "itemEditor" | "other";
  /** The items checked in the content inventory, or the item open in the editor. */
  readonly itemIds: readonly string[];
  /**
   * The content inventory's "select all": every item matching its filter, which may be more than the listing
   * shows, minus the items unticked afterwards. `itemIds` is empty then.
   */
  readonly selectAll?: {
    readonly filter: SerializedListingFilter;
    readonly languageId: string;
    readonly excludedIds: readonly string[];
  };
};

export const selectionFromContext = (context: Context): KontentSelection => {
  switch (context.currentPage) {
    case "contentInventory": {
      const { selectAll, selectedItemIds, unselectedItemIds } = context.itemListingSelection;
      return selectAll
        ? {
            page: "contentInventory",
            itemIds: [],
            selectAll: {
              filter: context.itemListingFilter,
              languageId: context.languageId,
              excludedIds: unselectedItemIds,
            },
          }
        : { page: "contentInventory", itemIds: selectedItemIds };
    }
    case "itemEditor":
      return { page: "itemEditor", itemIds: [context.contentItemId] };
    default:
      return { page: "other", itemIds: [] };
  }
};

// The SDK waits for Kontent.ai to answer, without a time limit.
const contextTimeoutMs = 5000;

const withTimeout = <T>(promise: Promise<T>): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), contextTimeoutMs))]);

/**
 * Narrow like a phone, so the content inventory stays usable next to the dialog; the layout scrolls
 * instead (the `dialog-mode` styles).
 */
const dialogWidth = { unit: "px", value: 450 } as const;
const dialogHeight = { unit: "%", value: 90 } as const;

/** The custom app settings, or undefined when they can't be read, so the tool works as if standalone. */
export const loadCustomAppSettings = async (): Promise<CustomAppSettings | undefined> => {
  try {
    // Loaded only inside Kontent.ai, so the standalone tool doesn't download it.
    const { getCustomAppContext, setPopupSize } = await import("@kontent-ai/custom-app-sdk");
    const result = await withTimeout(getCustomAppContext());
    if (!result || result.isError || !result.context.environmentId) return undefined;
    // The context doesn't say which display mode the app is in. Setting the dialog's size only works in a
    // dialog, so that is how it's detected.
    const popup = await withTimeout(setPopupSize(dialogWidth, dialogHeight));
    return parseCustomAppSettings(result.context.environmentId, result.context.appConfig, popup?.isError === false);
  } catch {
    return undefined;
  }
};

/**
 * Calls `onChange` with what is selected in Kontent.ai now and whenever it changes. Returns a function that
 * stops watching.
 */
export const watchKontentSelection = (onChange: (selection: KontentSelection) => void): (() => void) => {
  let stopped = false;
  let page: Context["currentPage"] | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  let checking = false;

  const report = (context: Context) => {
    if (!stopped) onChange(selectionFromContext(context));
  };

  const subscribe = async () => {
    const { observeCustomAppContext } = await import("@kontent-ai/custom-app-sdk");
    const result = await observeCustomAppContext(report);
    if (result.isError) return;
    await unsubscribe?.();
    unsubscribe = result.unsubscribe;
    page = result.context.currentPage;
    if (stopped) void unsubscribe();
    report(result.context);
  };

  // The SDK only reports changes on the page it subscribed on, so moving to another page (from an item to
  // the content inventory, say) needs a new subscription. Checked when the user moves to the dialog.
  const checkPage = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const { getCustomAppContext } = await import("@kontent-ai/custom-app-sdk");
      const result = await getCustomAppContext();
      if (result.isError) return;
      if (result.context.currentPage === page) report(result.context);
      else await subscribe();
    } finally {
      checking = false;
    }
  };

  void subscribe().catch(() => undefined);
  const onEnter = () => void checkPage().catch(() => undefined);
  window.addEventListener("focus", onEnter);
  document.documentElement.addEventListener("pointerenter", onEnter);

  return () => {
    stopped = true;
    window.removeEventListener("focus", onEnter);
    document.documentElement.removeEventListener("pointerenter", onEnter);
    void unsubscribe?.();
  };
};

/** Identifies a selection, to tell whether it changed since the items were loaded. */
export const selectionKey = (selection: KontentSelection): string =>
  JSON.stringify([selection.itemIds, selection.selectAll ?? null]);

const completionStatuses = {
  Unfinished: "unfinished",
  Ready: "ready",
  NotTranslated: "not_translated",
  AllDone: "all_done",
} as const;

const publishingStates = { Published: "published", Unpublished: "unpublished", None: "not_published_yet" } as const;

/**
 * The content inventory's filter as a Management API filter request. Everything maps except the search scope
 * (names only, or content too), which the API doesn't take: it searches both.
 */
export const inventoryFilter = (filter: SerializedListingFilter, languageId: string): FilterContract => {
  const ids = (values: readonly string[]) => values.map((id) => ({ id }));
  const phrase = filter.searchPhrase.trim();
  const workflowSteps = Object.entries(filter.selectedWorkflows).filter(([, steps]) => steps.length > 0);
  const taxonomies = Object.entries(filter.selectedTaxonomies).filter(([, terms]) => terms.length > 0);
  return {
    language: { id: languageId },
    ...(phrase ? { search_phrase: phrase } : {}),
    ...(filter.selectedContentTypes.length ? { content_types: ids(filter.selectedContentTypes) } : {}),
    ...(filter.selectedCollections.length ? { collections: ids(filter.selectedCollections) } : {}),
    ...(filter.selectedSpaces.length ? { spaces: ids(filter.selectedSpaces) } : {}),
    ...(filter.selectedContributors.length ? { contributors: ids(filter.selectedContributors) } : {}),
    ...(filter.selectedContentItemStatus.length
      ? { completion_statuses: filter.selectedContentItemStatus.map((s) => completionStatuses[s]) }
      : {}),
    ...(filter.selectedPublishingStates.length
      ? { publishing_states: filter.selectedPublishingStates.map((s) => publishingStates[s]) }
      : {}),
    ...(workflowSteps.length
      ? {
          workflow_steps: workflowSteps.map(([workflowId, stepIds]) => ({
            workflow_identifier: { id: workflowId },
            step_identifiers: ids(stepIds),
          })),
        }
      : {}),
    ...(taxonomies.length
      ? {
          taxonomy_groups: taxonomies.map(([groupId, termIds]) => ({
            taxonomy_identifier: { id: groupId },
            term_identifiers: ids(termIds),
          })),
        }
      : {}),
  };
};

/** The items selected in Kontent.ai: the checked ones, or for "select all" every item matching the filter. */
export const loadSelectedItems = async (
  client: Parameters<typeof loadItems>[0],
  selection: KontentSelection,
  languageCodename: string,
): Promise<Item[]> => {
  if (!selection.selectAll) return loadItems(client, selection.itemIds, languageCodename);
  const { filter, languageId, excludedIds } = selection.selectAll;
  const excluded = new Set(excludedIds);
  const ids = (await findItemIds(client, inventoryFilter(filter, languageId))).filter((id) => !excluded.has(id));
  return loadItems(client, ids, languageCodename);
};

/** How the selection in Kontent.ai differs from the items a preview was built from. */
export type SelectionChange = {
  /** Items added and removed, for checked items; unknown for "select all", which is only known once loaded. */
  readonly counts?: { readonly added: number; readonly removed: number };
  /** Nothing is selected now. */
  readonly empty: boolean;
};

/**
 * Undefined when the selection still matches, or when the user is on a page without items (the selection is
 * unknown there, not empty). `picked` is what the items were loaded from: their ids and the selection's key.
 */
export const selectionChange = (
  picked: { readonly ids: readonly string[]; readonly key?: string },
  selection: KontentSelection,
): SelectionChange | undefined => {
  if (selection.page === "other" || picked.key === selectionKey(selection)) return undefined;
  if (selection.selectAll) return { empty: false };
  const pickedIds = new Set(picked.ids);
  const selected = new Set(selection.itemIds);
  const added = selection.itemIds.filter((id) => !pickedIds.has(id)).length;
  const removed = picked.ids.filter((id) => !selected.has(id)).length;
  return added || removed ? { counts: { added, removed }, empty: selection.itemIds.length === 0 } : undefined;
};
