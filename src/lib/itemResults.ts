import type { PlanRow, TargetStatus } from "./plan";
import type { LiveEffect, Prediction } from "./publishing";

/** One result of copying a variant: what it does to the target item, or to what is published in the target. */
export type Result = LiveEffect | TargetStatus;

// Riskiest first: changes to what is published, then overwrites, then new content.
const riskOrder: readonly Result[] = [
  "unpublished",
  "replaces live content",
  "goes live",
  "schedule replaced",
  "schedule cancelled",
  "overwrites existing",
  "new language variant",
  "new item",
];

/** The riskiest of a variant's results, the one to show when there is room for only one. */
export const mainResult = (row: PlanRow, prediction: Prediction): Result =>
  riskOrder.find((r) => r === row.targetStatus || prediction.effects.includes(r as LiveEffect)) ?? row.targetStatus;

export type PreviewVariant = { readonly row: PlanRow; readonly prediction: Prediction };

/** One item's variants, with the result that sums them up. */
export type ItemResults = {
  readonly id: string;
  readonly variants: readonly PreviewVariant[];
  /** The riskiest result across the item's variants. */
  readonly main: Result;
  /** How many other results its variants have, when they differ per language. */
  readonly otherResults: number;
};

/** Groups variants by item, in the order the items first appear (selected items first, as selected). */
export const groupByItem = (variants: readonly PreviewVariant[]): ItemResults[] => {
  const byItem = new Map<string, PreviewVariant[]>();
  for (const variant of variants) {
    byItem.set(variant.row.id, [...(byItem.get(variant.row.id) ?? []), variant]);
  }
  return [...byItem].map(([id, itemVariants]) => {
    const results = new Set(itemVariants.map((v) => mainResult(v.row, v.prediction)));
    const main = riskOrder.find((r) => results.has(r)) ?? (itemVariants[0] as PreviewVariant).row.targetStatus;
    return { id, variants: itemVariants, main, otherResults: results.size - 1 };
  });
};
