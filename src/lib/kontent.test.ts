import type { ContentTypeElements } from "@kontent-ai/management-sdk";
import { describe, expect, test } from "vitest";

import { activeFilterCount, filterContract, flattenTaxonomyTerms, flattenTypeElements, noFilters } from "./kontent";

describe("filterContract", () => {
  test("sends nothing for no filters", () => {
    expect(filterContract(noFilters)).toEqual({});
    expect(activeFilterCount(noFilters)).toBe(0);
  });

  test("sends content types and collections by id", () => {
    expect(filterContract({ ...noFilters, contentTypeIds: ["t1", "t2"], collectionIds: ["c1"] })).toEqual({
      content_types: [{ id: "t1" }, { id: "t2" }],
      collections: [{ id: "c1" }],
    });
  });

  test("groups workflow steps by workflow", () => {
    expect(filterContract({ ...noFilters, workflowSteps: ["w1/s1", "w2/s3", "w1/s2"] })).toEqual({
      workflow_steps: [
        { workflow_identifier: { id: "w1" }, step_identifiers: [{ id: "s1" }, { id: "s2" }] },
        { workflow_identifier: { id: "w2" }, step_identifiers: [{ id: "s3" }] },
      ],
    });
  });

  test("groups taxonomy terms by group, with 'Not in group' as include_uncategorized", () => {
    expect(filterContract({ ...noFilters, taxonomyTerms: ["g1/t1", "g1/", "g2/"] })).toEqual({
      taxonomy_groups: [
        { taxonomy_identifier: { id: "g1" }, term_identifiers: [{ id: "t1" }], include_uncategorized: true },
        // The API rejects a group without term_identifiers, so an empty list is sent.
        { taxonomy_identifier: { id: "g2" }, term_identifiers: [], include_uncategorized: true },
      ],
    });
  });

  test("counts each filter with something chosen once", () => {
    expect(activeFilterCount({ ...noFilters, contentTypeIds: ["t1", "t2"], taxonomyTerms: ["g1/"] })).toBe(2);
  });
});

describe("flattenTypeElements", () => {
  const elements = [
    { id: "e1", codename: "title", name: "Title", type: "text" },
    { id: "e2", type: "guidelines", guidelines: "" },
    { id: "e3", codename: "seo", type: "snippet", snippet: { id: "snippet-1" } },
  ] as unknown as ContentTypeElements.ContentTypeElementModel[];
  const snippets = new Map([
    [
      "snippet-1",
      {
        elements: [
          { id: "e4", codename: "seo__description", name: "Description", type: "text" },
        ] as unknown as ContentTypeElements.ContentTypeElementModel[],
      },
    ],
  ]);

  test("flattens snippet elements in and leaves guidelines out", () => {
    expect(flattenTypeElements(elements, snippets)).toEqual([
      { codename: "title", name: "Title", type: "text" },
      { codename: "seo__description", name: "Description", type: "text" },
    ]);
  });

  test("skips a snippet that no longer exists", () => {
    expect(flattenTypeElements(elements, new Map())).toEqual([{ codename: "title", name: "Title", type: "text" }]);
  });
});

describe("flattenTaxonomyTerms", () => {
  test("lists nested terms with their group", () => {
    const terms = flattenTaxonomyTerms([
      {
        codename: "category",
        name: "Category",
        terms: [
          {
            id: "t1",
            codename: "phones",
            name: "Phones",
            terms: [{ id: "t2", codename: "android", name: "Android", terms: [] }],
          },
        ],
      },
    ]);
    expect([...terms.keys()]).toEqual(["t1", "t2"]);
    expect(terms.get("t2")).toEqual({
      codename: "android",
      name: "Android",
      groupCodename: "category",
      groupName: "Category",
    });
  });
});
