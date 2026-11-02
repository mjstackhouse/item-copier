import type { CopyResult, LogEntry } from "./copy";
import { type Connection, editItemUrl } from "./kontent";
import type { PublishMode } from "./publishing";
import type { Selection } from "./selection";
import { plural } from "./util";

type Environment = Pick<Connection, "environmentId" | "environmentName" | "projectName">;

/**
 * A plain-text record of one copy: where from and to, the settings, the outcome, links to the copied
 * items and the whole log. It is meant to be attached when someone reports a problem, so it never
 * includes the API keys.
 */
export const buildReport = (params: {
  readonly source: Environment;
  readonly target: Environment;
  readonly selection: Pick<Selection, "linkedItemsDepth" | "skipMissingReferences">;
  readonly languageCodenames: readonly string[];
  readonly publishMode: PublishMode;
  readonly result?: CopyResult;
  readonly error?: string;
  readonly log: readonly LogEntry[];
  readonly createdAt: Date;
}): string => {
  const { source, target, selection, result, error } = params;
  const summary = result?.summary;
  const depth = selection.linkedItemsDepth;
  const lines = [
    "Item Copier report",
    `Created: ${params.createdAt.toISOString()}`,
    "",
    `From: ${describeEnvironment(source)}`,
    `To: ${describeEnvironment(target)}`,
    `Publishing: ${params.publishMode === "match" ? "Match the source" : "Copy as drafts"}`,
    `Languages: ${params.languageCodenames.join(", ")}`,
    `Linked items: ${depth === 0 ? "none" : depth === Number.POSITIVE_INFINITY ? "all levels" : `${plural(depth, "level")} deep`}`,
    `Skip missing references: ${selection.skipMissingReferences ? "yes" : "no"}`,
    "",
    `Outcome: ${error ? "failed" : result ? result.state : "still running"}`,
  ];

  if (summary) {
    lines.push(
      `Items: ${summary.itemsOk} copied, ${summary.itemsFailed} failed`,
      `Language variants: ${summary.variantsOk} copied, ${summary.variantsFailed} failed, ${summary.variantsCancelled} cancelled`,
      `Assets: ${summary.assetsUploaded} uploaded, ${summary.assetsUpdated} updated`,
    );
    section(lines, "Not read from the source", summary.itemsNotRead);
    section(lines, "Assets placed in the root folder", summary.assetsMovedToRoot);
    section(lines, "Errors", summary.errors);
    section(
      lines,
      "Copied language variants",
      summary.copied.map(
        (c) =>
          `${c.name} (${c.codename}, ${c.languageCodename})${
            c.targetItemId ? `: ${editItemUrl(target.environmentId, c.languageCodename, c.targetItemId)}` : ""
          }`,
      ),
    );
  }
  if (error) section(lines, "Error", [error]);
  section(
    lines,
    "Log",
    params.log.map((e) => `${e.time.toISOString()} ${e.type ? `[${e.type}] ` : ""}${e.message}`),
  );

  return `${lines.join("\n")}\n`;
};

const describeEnvironment = (e: Environment) => `${e.projectName} / ${e.environmentName} (${e.environmentId})`;

const section = (lines: string[], title: string, entries: readonly string[]) => {
  if (entries.length) lines.push("", `${title}:`, ...entries.map((e) => `  ${e}`));
};
