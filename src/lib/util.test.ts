import { expect, test } from "vitest";

import { plural } from "./util";

test("uses the singular only for exactly one", () => {
  expect(plural(1, "item")).toBe("1 item");
  expect(plural(0, "item")).toBe("0 items");
  expect(plural(2, "language variant")).toBe("2 language variants");
});

test("takes an irregular plural", () => {
  expect(plural(3, "reference to a deleted item", "references to deleted items")).toBe("3 references to deleted items");
});
