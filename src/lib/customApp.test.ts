import { expect, test } from "vitest";

import type { CustomAppContext } from "@kontent-ai/custom-app-sdk";

import {
  inventoryFilter,
  parseCustomAppSettings,
  selectionChange,
  selectionFromContext,
  selectionKey,
} from "./customApp";

const current = "current-env";

test("without settings, only the current environment is known", () => {
  expect(parseCustomAppSettings(current, undefined)).toEqual({
    currentEnvironmentId: current,
    sourceEnvironmentId: undefined,
    targetEnvironmentId: undefined,
    dialog: false,
  });
});

test("thisEnvironment fills that side with the current environment", () => {
  expect(parseCustomAppSettings(current, { thisEnvironment: "source" }).sourceEnvironmentId).toBe(current);
  expect(parseCustomAppSettings(current, { thisEnvironment: "target" }).targetEnvironmentId).toBe(current);
});

test("takes environment IDs for either side, trimmed", () => {
  const settings = parseCustomAppSettings(current, { thisEnvironment: "source", targetEnvironmentId: " other-env " });
  expect(settings).toMatchObject({ sourceEnvironmentId: current, targetEnvironmentId: "other-env" });
});

test("an explicit environment ID takes precedence over thisEnvironment", () => {
  expect(
    parseCustomAppSettings(current, { thisEnvironment: "target", targetEnvironmentId: "other-env" })
      .targetEnvironmentId,
  ).toBe("other-env");
});

test("ignores keys, unknown sides and values of the wrong kind", () => {
  const settings = parseCustomAppSettings(current, {
    thisEnvironment: "both",
    sourceEnvironmentId: 42,
    targetEnvironmentId: "  ",
    targetManagementApiKey: "secret",
  });
  expect(settings).toEqual({
    currentEnvironmentId: current,
    sourceEnvironmentId: undefined,
    targetEnvironmentId: undefined,
    dialog: false,
  });
});

test("in a dialog, the source is always the current environment and the settings only fill in the target", () => {
  expect(
    parseCustomAppSettings(
      current,
      { thisEnvironment: "target", sourceEnvironmentId: "x", targetEnvironmentId: "other-env" },
      true,
    ),
  ).toEqual({
    currentEnvironmentId: current,
    sourceEnvironmentId: current,
    targetEnvironmentId: "other-env",
    dialog: true,
  });
});

test("in a dialog, a target that is the current environment is left empty", () => {
  expect(parseCustomAppSettings(current, { targetEnvironmentId: current }, true).targetEnvironmentId).toBeUndefined();
});

const base = {
  path: "",
  pageTitle: "",
  environmentId: current,
  userId: "user",
  userEmail: "user@example.com",
  userRoles: [],
};

test("the content inventory gives the checked items, in the order they were checked", () => {
  const context = {
    ...base,
    currentPage: "contentInventory",
    languageId: "lang",
    itemListingFilter: {},
    itemListingSelection: { selectAll: false, selectedItemIds: ["b", "a"], unselectedItemIds: [] },
  } as unknown as CustomAppContext;
  expect(selectionFromContext(context)).toEqual({ page: "contentInventory", itemIds: ["b", "a"] });
});

test("the item editor gives the open item", () => {
  const context = {
    ...base,
    currentPage: "itemEditor",
    contentItemId: "item",
    languageId: "lang",
    validationErrors: {},
  } as CustomAppContext;
  expect(selectionFromContext(context)).toEqual({ page: "itemEditor", itemIds: ["item"] });
});

test("other pages have no items to copy", () => {
  expect(selectionFromContext({ ...base, currentPage: "other" } as CustomAppContext)).toEqual({
    page: "other",
    itemIds: [],
  });
});

test("a selection change counts the items added and removed since the preview", () => {
  const selection = { page: "contentInventory", itemIds: ["a", "c", "d"] } as const;
  expect(selectionChange({ ids: ["a", "b"] }, selection)).toEqual({ counts: { added: 2, removed: 1 }, empty: false });
  expect(selectionChange({ ids: ["c", "a", "d"] }, selection)).toBeUndefined();
});

test("a page without items isn't a selection change; unticking everything is", () => {
  expect(selectionChange({ ids: ["a"] }, { page: "other", itemIds: [] })).toBeUndefined();
  expect(selectionChange({ ids: ["a"] }, { page: "contentInventory", itemIds: [] })).toEqual({
    counts: { added: 0, removed: 1 },
    empty: true,
  });
});

const noFilter = {
  selectedCollections: [],
  selectedContentItemStatus: [],
  selectedContentTypes: [],
  selectedContributors: [],
  selectedPublishingStates: [],
  selectedSpaces: [],
  selectedTaxonomies: {},
  selectedWorkflows: {},
  searchPhrase: "",
  searchScope: [],
} as const;

test("select all in the content inventory keeps its filter and the items unticked afterwards", () => {
  const context = {
    ...base,
    currentPage: "contentInventory",
    languageId: "lang",
    itemListingFilter: noFilter,
    itemListingSelection: { selectAll: true, selectedItemIds: [], unselectedItemIds: ["x"] },
  } as unknown as CustomAppContext;
  expect(selectionFromContext(context)).toEqual({
    page: "contentInventory",
    itemIds: [],
    selectAll: { filter: noFilter, languageId: "lang", excludedIds: ["x"] },
  });
});

test("a select all selection changes only when its filter or exceptions do", () => {
  const selection = {
    page: "contentInventory",
    itemIds: [],
    selectAll: { filter: noFilter, languageId: "lang", excludedIds: [] },
  } as const;
  expect(selectionChange({ ids: ["a"], key: selectionKey(selection) }, selection)).toBeUndefined();
  const narrower = { ...selection, selectAll: { ...selection.selectAll, excludedIds: ["a"] } };
  expect(selectionChange({ ids: ["a"], key: selectionKey(selection) }, narrower)).toEqual({ empty: false });
});

test("the content inventory's filter becomes a Management API filter request", () => {
  expect(inventoryFilter(noFilter, "lang")).toEqual({ language: { id: "lang" } });
  expect(
    inventoryFilter(
      {
        ...noFilter,
        searchPhrase: " surgery ",
        selectedContentTypes: ["type"],
        selectedContentItemStatus: ["NotTranslated"],
        selectedPublishingStates: ["None", "Published"],
        selectedWorkflows: { workflow: ["step"], other: [] },
        selectedTaxonomies: { group: ["term"] },
      } as never,
      "lang",
    ),
  ).toEqual({
    language: { id: "lang" },
    search_phrase: "surgery",
    content_types: [{ id: "type" }],
    completion_statuses: ["not_translated"],
    publishing_states: ["not_published_yet", "published"],
    workflow_steps: [{ workflow_identifier: { id: "workflow" }, step_identifiers: [{ id: "step" }] }],
    taxonomy_groups: [{ taxonomy_identifier: { id: "group" }, term_identifiers: [{ id: "term" }] }],
  });
});
