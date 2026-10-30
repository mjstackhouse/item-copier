import { type ContentTypeElements, ManagementClient } from "@kontent-ai/management-sdk";

import { loadWorkflowSteps, type VariantState, type WorkflowSteps } from "./publishing";

export type Connection = {
  readonly environmentId: string;
  readonly apiKey: string;
  readonly projectName: string;
  readonly environmentName: string;
  readonly client: ManagementClient;
};

export type Language = {
  readonly id: string;
  readonly codename: string;
  readonly name: string;
  readonly isDefault: boolean;
};

export type Item = {
  readonly id: string;
  readonly codename: string;
  readonly name: string;
  readonly typeId: string;
  readonly collectionId: string;
};

export type ContentTypeInfo = {
  readonly id: string;
  readonly codename: string;
  readonly name: string;
};

/** A taxonomy element of a content type (directly or through a snippet) and the group it uses. */
export type TaxonomyElementInfo = {
  readonly name: string;
  readonly taxonomyGroupId: string;
};

/** A content type element that holds content, with snippet elements flattened in (guidelines left out). */
export type TypeElementInfo = { readonly codename: string; readonly name: string; readonly type: string };

/** A taxonomy term, with the group it belongs to. */
export type TaxonomyTermInfo = {
  readonly codename: string;
  readonly name: string;
  readonly groupCodename: string;
  readonly groupName: string;
};

type SnippetLike = { readonly elements: readonly ContentTypeElements.ContentTypeElementModel[] };

/**
 * The elements of a content type the way the toolkit sees them: snippet elements are flattened in,
 * and guidelines (which hold no content) are left out.
 */
export const flattenTypeElements = (
  elements: readonly ContentTypeElements.ContentTypeElementModel[],
  snippetsById: ReadonlyMap<string, SnippetLike>,
): TypeElementInfo[] =>
  elements.flatMap((e): TypeElementInfo[] => {
    if (e.type === "snippet") {
      const snippet = e.snippet.id ? snippetsById.get(e.snippet.id) : undefined;
      return snippet ? flattenTypeElements(snippet.elements, snippetsById) : [];
    }
    if (e.type === "guidelines" || !e.codename) return [];
    return [{ codename: e.codename, name: ("name" in e && e.name) || e.codename, type: e.type }];
  });

export const flattenTaxonomyTerms = (
  groups: readonly { id: string; codename: string; name: string; terms: readonly unknown[] }[],
): Map<string, TaxonomyTermInfo> => {
  const terms = new Map<string, TaxonomyTermInfo>();
  type Term = { id: string; codename: string; name: string; terms: readonly Term[] };
  for (const group of groups) {
    const add = (list: readonly Term[]) => {
      for (const term of list) {
        terms.set(term.id, { codename: term.codename, name: term.name, groupCodename: group.codename, groupName: group.name });
        add(term.terms);
      }
    };
    add(group.terms as readonly Term[]);
  }
  return terms;
};

export type SourceData = {
  readonly languages: readonly Language[];
  readonly workflowSteps: WorkflowSteps;
  /** Collection id -> codename. */
  readonly collectionCodenames: ReadonlyMap<string, string>;
  readonly taxonomyGroupIds: ReadonlySet<string>;
  /** Content type id -> its taxonomy elements, including those from snippets. */
  readonly taxonomyElementsByType: ReadonlyMap<string, readonly TaxonomyElementInfo[]>;
  readonly typesById: ReadonlyMap<string, ContentTypeInfo>;
  /** Content type id -> its content elements, including those from snippets. */
  readonly typeElements: ReadonlyMap<string, readonly TypeElementInfo[]>;
  /** Taxonomy term id -> the term and its group, across all taxonomy groups. */
  readonly taxonomyTerms: ReadonlyMap<string, TaxonomyTermInfo>;
  /** Element id -> element type ("modular_content", "rich_text", ...), across all types and snippets. */
  readonly elementTypes: ReadonlyMap<string, string>;
};

/** Creates a client and checks the credentials by loading the environment's name. */
export const connect = async (environmentId: string, apiKey: string): Promise<Connection> => {
  const client = new ManagementClient({ environmentId, apiKey });
  const info = await client.environmentInformation().toPromise();

  return {
    environmentId,
    apiKey,
    projectName: info.data.project.name,
    environmentName: info.data.project.environment,
    client,
  };
};

/**
 * Loads what the item picker and the linked-item lookup need from the source environment.
 * Items themselves are loaded on demand: see `searchItems` and `getItemsWithVariants`.
 */
export const loadSourceData = async (client: ManagementClient): Promise<SourceData> => {
  const [languages, types, snippets, workflowSteps, collections, taxonomies] = await Promise.all([
    client.listLanguages().toAllPromise(),
    client.listContentTypes().toAllPromise(),
    client.listContentTypeSnippets().toAllPromise(),
    loadWorkflowSteps(client),
    client.listCollections().toPromise(),
    client.listTaxonomies().toAllPromise(),
  ]);

  const taxonomyElementsOf = (elements: readonly ContentTypeElements.ContentTypeElementModel[]): TaxonomyElementInfo[] =>
    elements.flatMap((e) =>
      e.type === "taxonomy" && e.taxonomy_group.id ? [{ name: e.name ?? e.codename ?? "", taxonomyGroupId: e.taxonomy_group.id }] : [],
    );
  const snippetsById = new Map(snippets.data.items.map((s) => [s.id, s]));

  const elementTypes = new Map<string, string>();
  for (const element of [...types.data.items, ...snippets.data.items].flatMap((t) => t.elements)) {
    if (element.id) {
      elementTypes.set(element.id, element.type);
    }
  }

  return {
    languages: languages.data.items
      .filter((l) => l.isActive)
      .map((l) => ({ id: l.id, codename: l.codename, name: l.name, isDefault: l.isDefault ?? false })),
    workflowSteps,
    collectionCodenames: new Map(collections.data.collections.map((c) => [c.id, c.codename])),
    taxonomyGroupIds: new Set(taxonomies.data.items.map((t) => t.id)),
    taxonomyElementsByType: new Map(
      types.data.items.map((t) => [
        t.id,
        [
          ...taxonomyElementsOf(t.elements),
          ...t.elements.flatMap((e) => {
            const snippet = e.type === "snippet" && e.snippet.id ? snippetsById.get(e.snippet.id) : undefined;
            return snippet ? taxonomyElementsOf(snippet.elements) : [];
          }),
        ],
      ]),
    ),
    typesById: new Map(types.data.items.map((t) => [t.id, { id: t.id, codename: t.codename, name: t.name }])),
    typeElements: new Map(types.data.items.map((t) => [t.id, flattenTypeElements(t.elements, snippetsById)])),
    taxonomyTerms: flattenTaxonomyTerms(taxonomies.data.items),
    elementTypes,
  };
};

/** The parts of a variant element (as the API returns it) needed to find referenced items. */
export type VariantElement = {
  readonly element: { readonly id?: string };
  readonly value: unknown;
  readonly components?: readonly { readonly elements: readonly VariantElement[] }[];
};

export type ItemWithVariant = {
  readonly item: Item;
  /** Undefined when the item has no variant in the requested language. */
  readonly elements?: readonly VariantElement[];
  /** Workflow step and schedule of the latest version; set whenever `elements` is. */
  readonly state?: VariantState;
};

export type SearchResult = {
  readonly items: readonly Item[];
  /** Pass to `searchItems` to load the next page; null on the last page. */
  readonly continuationToken: string | null;
};

const toItem = (contract: {
  id: string;
  codename: string;
  name: string;
  type: { id?: string };
  collection: { id?: string };
}): Item => ({
  id: contract.id,
  codename: contract.codename,
  name: contract.name,
  typeId: contract.type.id ?? "",
  collectionId: contract.collection.id ?? "",
});

/**
 * Finds items with a variant in the language whose name or text content matches the phrase,
 * one page (up to 50 items) at a time. An empty phrase lists all items in that language.
 */
export const searchItems = async (params: {
  readonly client: ManagementClient;
  readonly searchPhrase: string;
  readonly languageCodename: string;
  readonly continuationToken?: string | null;
}): Promise<SearchResult> => {
  const phrase = params.searchPhrase.trim();
  const query = params.client.filterItemsWithVariants().withData({
    filters: { language: { codename: params.languageCodename }, ...(phrase ? { search_phrase: phrase } : {}) },
    order: { by: "name", direction: "asc" },
  });
  if (params.continuationToken) query.xContinuationToken(params.continuationToken);
  const page = await query.toPromise();

  // The filter only returns ids, so load names and types in one more request.
  const ids = page.data.items.flatMap((r) => (r.item.id ? [r.item.id] : []));
  const details = await getItemsWithVariants(params.client, ids, params.languageCodename);

  return {
    items: ids.flatMap((id) => {
      const found = details.get(id);
      return found ? [found.item] : [];
    }),
    continuationToken: page.data.pagination.continuationToken,
  };
};

const bulkGetLimit = 100;

/**
 * Loads items and their variants in one language, up to 100 per request.
 * Items that do not exist are missing from the result; items without a variant in the
 * language have no `elements`.
 */
export const getItemsWithVariants = async (
  client: ManagementClient,
  ids: readonly string[],
  languageCodename: string,
): Promise<Map<string, ItemWithVariant>> => {
  const result = new Map<string, ItemWithVariant>();

  // One chunk at a time: the Management API advises against parallel requests.
  for (let start = 0; start < ids.length; start += bulkGetLimit) {
    const chunk = ids.slice(start, start + bulkGetLimit);
    const response = await client
      .bulkGetItemsWithVariants()
      .withData({ variants: chunk.map((id) => ({ item: { id }, language: { codename: languageCodename } })) })
      .toAllPromise();

    for (const { item, variant } of response.data.items) {
      result.set(item.id, {
        item: toItem(item),
        elements: variant?.elements,
        state: variant && {
          workflowId: variant.workflow.workflow_identifier.id ?? "",
          stepId: variant.workflow.step_identifier.id ?? "",
          publishTime: variant.schedule?.publish_time ?? null,
          unpublishTime: variant.schedule?.unpublish_time ?? null,
        },
      });
    }
  }

  // Bulk get may leave out items that exist but have no variant in the language.
  // Check those one by one so they are not mistaken for deleted items.
  for (const id of ids.filter((i) => !result.has(i))) {
    try {
      const item = await client.viewContentItem().byItemId(id).toPromise();
      result.set(id, { item: toItem(item.data) });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  return result;
};

/** True when a Management API call failed because the thing does not exist. */
export const isNotFound = (error: unknown): boolean => {
  const status = (error as { originalError?: { response?: { status?: number } } } | undefined)?.originalError
    ?.response?.status;
  return status === 404;
};

/** Runs `fn` over `inputs` with at most `limit` calls in flight, keeping the input order. */
export const mapWithLimit = async <TIn, TOut>(
  inputs: readonly TIn[],
  limit: number,
  fn: (input: TIn) => Promise<TOut>,
): Promise<TOut[]> => {
  const results: TOut[] = new Array<TOut>(inputs.length);
  let next = 0;

  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      results[index] = await fn(inputs[index] as TIn);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
};

export const errorMessage = (error: unknown): string => {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
};
