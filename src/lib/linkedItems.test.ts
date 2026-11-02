import { describe, expect, test } from "vitest";

import type { VariantElement } from "./kontent";
import { findReferencedItemIds, findTaxonomyTermIds } from "./linkedItems";

const elementTypes = new Map([
  ["links", "modular_content"],
  ["subpages", "subpages"],
  ["body", "rich_text"],
  ["tags", "taxonomy"],
  ["title", "text"],
]);

const element = (id: string, value: unknown, components?: VariantElement["components"]): VariantElement => ({
  element: { id },
  value,
  components,
});

describe("findReferencedItemIds", () => {
  test("finds linked items and subpages", () => {
    const ids = findReferencedItemIds(
      [element("links", [{ id: "a" }, { id: "b" }]), element("subpages", [{ id: "c" }])],
      elementTypes,
    );
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  test("finds items inserted in rich text and items linked from it, but not components", () => {
    const body = [
      '<p>Intro <a data-item-id="linked">link</a></p>',
      '<object type="application/kenticocloud" data-type="item" data-id="inserted"></object>',
      '<object type="application/kenticocloud" data-type="component" data-id="component-1"></object>',
    ].join("");
    expect([...findReferencedItemIds([element("body", body)], elementTypes)]).toEqual(["inserted", "linked"]);
  });

  test("finds references inside rich-text components, at any depth", () => {
    const nested = element("body", '<object type="application/kenticocloud" data-type="item" data-id="deep"></object>');
    const ids = findReferencedItemIds(
      [
        element("body", "<p></p>", [
          { elements: [element("links", [{ id: "in-component" }]), element("body", "", [{ elements: [nested] }])] },
        ]),
      ],
      elementTypes,
    );
    expect([...ids].sort()).toEqual(["deep", "in-component"]);
  });

  test("ignores look-alike text in other elements and unknown elements", () => {
    const ids = findReferencedItemIds(
      [element("title", '<a data-item-id="not-a-link">'), element("removed", [{ id: "x" }])],
      elementTypes,
    );
    expect(ids.size).toBe(0);
  });

  test("lists each item once", () => {
    const ids = findReferencedItemIds(
      [element("links", [{ id: "a" }]), element("subpages", [{ id: "a" }])],
      elementTypes,
    );
    expect([...ids]).toEqual(["a"]);
  });
});

describe("findTaxonomyTermIds", () => {
  test("finds terms in taxonomy elements, including inside components", () => {
    const ids = findTaxonomyTermIds(
      [
        element("tags", [{ id: "t1" }]),
        element("body", "", [{ elements: [element("tags", [{ id: "t2" }]), element("links", [{ id: "item" }])] }]),
      ],
      elementTypes,
    );
    expect([...ids]).toEqual(["t1", "t2"]);
  });
});
