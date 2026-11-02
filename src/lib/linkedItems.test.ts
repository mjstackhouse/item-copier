import type { ManagementClient } from "@kontent-ai/management-sdk";
import { describe, expect, test, vi } from "vitest";

import { getItemsWithVariants, type ItemWithVariant, type VariantElement } from "./kontent";
import {
  expandWithLinkedItems,
  findReferencedAssetIds,
  findReferencedItemIds,
  findTaxonomyTermIds,
} from "./linkedItems";

vi.mock("./kontent", () => ({ getItemsWithVariants: vi.fn() }));

const elementTypes = new Map([
  ["links", "modular_content"],
  ["subpages", "subpages"],
  ["body", "rich_text"],
  ["tags", "taxonomy"],
  ["image", "asset"],
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

describe("findReferencedAssetIds", () => {
  test("finds assets in asset elements, rich-text images and links, and components", () => {
    const body = '<figure data-asset-id="figure"><img src="#"></figure><p><a data-asset-id="link">file</a></p>';
    const ids = findReferencedAssetIds(
      [
        element("image", [{ id: "element" }]),
        element("body", body, [{ elements: [element("image", [{ id: "in-component" }])] }]),
      ],
      elementTypes,
    );
    expect([...ids].sort()).toEqual(["element", "figure", "in-component", "link"]);
  });
});

describe("expandWithLinkedItems", () => {
  const variant = (id: string, links: readonly string[]): ItemWithVariant => ({
    item: { id, codename: id, name: id, typeId: "type", collectionId: "collection" },
    elements: [
      element(
        "links",
        links.map((l) => ({ id: l })),
      ),
    ],
    state: { workflowId: "w", stepId: "s", publishTime: null, unpublishTime: null },
  });
  // "picked" links to "linked", which links to "deleted", which no longer exists.
  const source = new Map([
    ["picked", variant("picked", ["linked"])],
    ["linked", variant("linked", ["deleted"])],
  ]);
  vi.mocked(getItemsWithVariants).mockImplementation(
    async (_client, ids) =>
      new Map(ids.flatMap((id) => (source.has(id) ? [[id, source.get(id) as ItemWithVariant]] : []))),
  );
  const expand = (maxDepth: number) =>
    expandWithLinkedItems({
      client: {} as ManagementClient,
      pickedIds: ["picked"],
      languageCodenames: ["en"],
      maxDepth,
      elementTypes,
    });

  test("finds a deleted item linked from beyond the chosen depth, without copying the linked items", async () => {
    const result = await expand(1);
    expect(result.items.map((i) => i.id)).toEqual(["picked", "linked"]);
    expect(result.deletedIds).toEqual(["deleted"]);
  });

  test("follows every level with an unlimited depth", async () => {
    const result = await expand(Number.POSITIVE_INFINITY);
    expect(result.items.map((i) => i.id)).toEqual(["picked", "linked"]);
    expect(result.deletedIds).toEqual(["deleted"]);
  });

  test("with depth 0, copies only the picked items but still checks their links", async () => {
    const result = await expand(0);
    expect(result.items.map((i) => i.id)).toEqual(["picked"]);
    expect(result.deletedIds).toEqual([]);
  });
});
