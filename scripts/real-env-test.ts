/**
 * Runs the app's own preview and copy code against real Kontent.ai environments, with Node.js instead
 * of the browser, and checks the copy's result against the preview's predictions.
 *
 * Reads SOURCE_ENVIRONMENT_ID, SOURCE_API_KEY, TARGET_ENVIRONMENT_ID and TARGET_API_KEY from .env.local
 * (never committed). The target should be a test environment: "copy" creates, overwrites, publishes
 * and unpublishes content there, and only runs with --yes.
 *
 *   npm run test:real -- plan <item codename> [more codenames] [options]
 *   npm run test:real -- copy <item codename> [more codenames] [options] --yes
 *
 * Options:
 *   --languages=en-US,cs   languages to copy (default: all active languages in the source)
 *   --depth=N              levels of linked items to follow, 0 to 3 (default: 1)
 *   --drafts               "Copy as drafts" instead of "Match the source"
 *   --skip-deleted         skip references to items that no longer exist in the source
 *   --cancel-after=N       press "Cancel copy" after N language variants have been imported
 *   --verbose              print every toolkit log line during the copy
 *
 * What it can't check: browser-only behavior (asset download and upload from a browser, the screens).
 */
import { copyItems } from "../src/lib/copy";
import { type Connection, connect, errorMessage, loadSourceData, type SourceData } from "../src/lib/kontent";
import { buildPlan, type Plan, type PlanRow } from "../src/lib/plan";
import { predict, type PublishMode } from "../src/lib/publishing";

const usage = "Usage: npm run test:real -- <plan|copy> <item codename>... [--languages=a,b] [--depth=N] [--drafts] [--skip-deleted] [--cancel-after=N] [--verbose] [--yes]";

type Options = {
  readonly command: "plan" | "copy";
  readonly codenames: readonly string[];
  readonly languages?: readonly string[];
  readonly depth: number;
  readonly mode: PublishMode;
  readonly skipDeleted: boolean;
  readonly cancelAfter?: number;
  readonly verbose: boolean;
  readonly yes: boolean;
};

const parseArgs = (args: readonly string[]): Options => {
  const [command, ...rest] = args;
  if (command !== "plan" && command !== "copy") throw new Error(usage);
  const flags = new Map(
    rest.filter((a) => a.startsWith("--")).map((a) => {
      const [name = "", value = "true"] = a.slice(2).split("=");
      return [name, value] as const;
    }),
  );
  const codenames = rest.filter((a) => !a.startsWith("--"));
  if (!codenames.length) throw new Error(usage);
  const depth = Number(flags.get("depth") ?? 1);
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error("--depth must be 0 to 3.");

  return {
    command,
    codenames,
    languages: flags.get("languages")?.split(",").filter(Boolean),
    depth,
    mode: flags.has("drafts") ? "drafts" : "match",
    skipDeleted: flags.has("skip-deleted"),
    cancelAfter: flags.has("cancel-after") ? Number(flags.get("cancel-after")) : undefined,
    verbose: flags.has("verbose"),
    yes: flags.has("yes"),
  };
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing. Add it to .env.local.`);
  return value;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  // Only names are printed, never keys.
  const [source, target] = await Promise.all([
    connect(requireEnv("SOURCE_ENVIRONMENT_ID"), requireEnv("SOURCE_API_KEY")),
    connect(requireEnv("TARGET_ENVIRONMENT_ID"), requireEnv("TARGET_API_KEY")),
  ]);
  console.log(`Source: ${source.projectName} / ${source.environmentName}`);
  console.log(`Target: ${target.projectName} / ${target.environmentName}`);
  if (source.environmentId === target.environmentId) throw new Error("Source and target are the same environment.");

  const sourceData = await loadSourceData(source.client);
  const languages = options.languages ?? sourceData.languages.map((l) => l.codename);
  const unknown = languages.filter((c) => !sourceData.languages.some((l) => l.codename === c));
  if (unknown.length) throw new Error(`Unknown or inactive source languages: ${unknown.join(", ")}`);

  const pickedIds = await Promise.all(
    options.codenames.map(async (codename) => {
      try {
        return (await source.client.viewContentItem().byItemCodename(codename).toPromise()).data.id;
      } catch (error) {
        throw new Error(`Item "${codename}" was not found in the source: ${errorMessage(error)}`);
      }
    }),
  );

  const plan = await runPlan({ source, target, sourceData, pickedIds, languages, depth: options.depth });
  printPlan(plan, options.mode);
  if (options.command === "plan") return;

  if (plan.blockers.length) throw new Error("The preview has blockers, so the copy would not be allowed.");
  if (plan.deletedReferenceCount > 0 && !options.skipDeleted) {
    throw new Error("The preview found references to deleted items. Run again with --skip-deleted.");
  }
  if (!options.yes) {
    console.log(`\nNothing was copied. Run again with --yes to copy into "${target.environmentName}".`);
    return;
  }

  await runCopy({ options, source, target, sourceData, plan });

  console.log("\nChecking the target against the preview's predictions…");
  const after = await runPlan({ source, target, sourceData, pickedIds, languages, depth: options.depth, quiet: true });
  verify(plan, after, options.mode);
};

const runPlan = async (params: {
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly pickedIds: readonly string[];
  readonly languages: readonly string[];
  readonly depth: number;
  readonly quiet?: boolean;
}): Promise<Plan> =>
  buildPlan({
    source: params.source,
    target: params.target,
    sourceData: params.sourceData,
    pickedIds: params.pickedIds,
    languageCodenames: params.languages,
    linkedItemsDepth: params.depth,
    onProgress: (message) => params.quiet || console.log(`  ${message}`),
  });

const predictionFor = (row: PlanRow, mode: PublishMode) =>
  row.sourcePublishing
    ? predict({ mode, source: row.sourcePublishing, target: row.targetPublishing, firstStepName: row.firstStepName })
    : { outcome: "", effects: [] };

const printPlan = (plan: Plan, mode: PublishMode) => {
  console.log(`\nPreview (${mode === "drafts" ? "Copy as drafts" : "Match the source"}): ${plan.rows.length} variant(s)`);
  for (const row of plan.rows) {
    const { outcome, effects } = predictionFor(row, mode);
    const why = row.depth === 0 ? "selected" : `linked, level ${row.depth}`;
    console.log(
      `  ${row.item.codename} (${row.languageCodename}) [${why}] ${row.targetStatus} -> ${outcome}${effects.length ? ` [${effects.join(", ")}]` : ""}`,
    );
  }
  for (const b of plan.blockers) console.log(`  BLOCKER: ${b}`);
  for (const w of plan.warnings) console.log(`  WARNING: ${w}`);
  if (plan.deletedReferenceCount) console.log(`  Deleted references: ${plan.deletedReferenceCount}`);
  if (plan.skippedVariants.length) {
    console.log(
      `  Skipped (no variant in the source): ${plan.skippedVariants.map((v) => `${v.itemName} (${v.languageCodename})`).join(", ")}`,
    );
  }
};

const runCopy = async (params: {
  readonly options: Options;
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly plan: Plan;
}) => {
  const { options, plan } = params;
  console.log(`\nCopying ${plan.rows.length} variant(s) into "${params.target.environmentName}"…`);
  const abort = new AbortController();
  let variantsDone = 0;
  // The toolkit also logs variant progress while reading the target's existing variants, before writing
  // anything; only count lines after it starts importing variants.
  let importingVariants = false;

  const result = await copyItems({
    source: params.source,
    target: params.target,
    variants: plan.rows.map((r) => ({ itemCodename: r.item.codename, languageCodename: r.languageCodename })),
    skipMissingReferences: options.skipDeleted,
    publishMode: options.mode,
    sourceWorkflowSteps: params.sourceData.workflowSteps,
    signal: abort.signal,
    onLog: (entry) => {
      if (options.verbose || entry.type === "error" || entry.type === "warning") {
        console.log(`  ${entry.type ?? ""} ${entry.message}`);
      }
      if (entry.type === "info" && /^Importing '\d+' language variants/.test(entry.message)) importingVariants = true;
      // Progress lines for imported variants look like "languageVariant 50% Some item".
      if (importingVariants && entry.type === "languageVariant" && /\d+%/.test(entry.message) && !/^0%/.test(entry.message)) {
        variantsDone++;
        if (options.cancelAfter !== undefined && variantsDone >= options.cancelAfter && !abort.signal.aborted) {
          console.log(`  Cancelling after ${variantsDone} variant(s)`);
          abort.abort();
        }
      }
    },
  });

  console.log(`\nResult: ${result.state}`);
  const s = result.summary;
  if (!s) {
    console.log("  Nothing was written to the target.");
    return;
  }
  console.log(
    `  Items: ${s.itemsOk} ok, ${s.itemsFailed} failed. Variants: ${s.variantsOk} ok, ${s.variantsFailed} failed, ${s.variantsCancelled} cancelled. Assets: ${s.assetsUploaded} uploaded, ${s.assetsUpdated} updated.`,
  );
  if (s.itemsNotRead.length) console.log(`  Not read from the source: ${s.itemsNotRead.join(", ")}`);
  if (s.assetsMovedToRoot.length) console.log(`  Assets placed in the root folder: ${s.assetsMovedToRoot.join(", ")}`);
  for (const e of s.errors) console.log(`  ERROR: ${e}`);
};

/** Compares the target after the copy with what the preview predicted, variant by variant. */
const verify = (before: Plan, after: Plan, mode: PublishMode) => {
  const afterByKey = new Map(after.rows.map((r) => [`${r.id}/${r.languageCodename}`, r]));
  let failures = 0;

  for (const row of before.rows) {
    const label = `${row.item.codename} (${row.languageCodename})`;
    const now = afterByKey.get(`${row.id}/${row.languageCodename}`)?.targetPublishing;
    const source = row.sourcePublishing;
    const problems: string[] = [];

    if (!now) problems.push("no variant in the target");
    else if (source) {
      const expectedPublished =
        mode === "drafts" ? (row.targetPublishing?.hasPublishedVersion ?? false) : source.hasPublishedVersion;
      if (now.hasPublishedVersion !== expectedPublished) {
        problems.push(`published version ${now.hasPublishedVersion ? "exists" : "missing"}, expected ${expectedPublished ? "one" : "none"}`);
      }
      const expectedPublishTime = mode === "drafts" ? null : source.publishTime;
      if ((now.publishTime ?? null) !== (expectedPublishTime ?? null)) {
        problems.push(`scheduled publish ${now.publishTime ?? "none"}, expected ${expectedPublishTime ?? "none"}`);
      }
      const expectedStep =
        mode === "drafts" ? (source.stepKind === "draft" ? source.stepName : row.firstStepName) : source.stepName;
      // A latest version that is published or scheduled is checked through the published version and schedule above.
      if (now.stepKind === "draft" && expectedStep && now.stepName !== expectedStep) {
        problems.push(`latest version in the "${now.stepName}" step, expected "${expectedStep}"`);
      }
    }

    if (problems.length) failures++;
    console.log(`  ${problems.length ? "MISMATCH" : "ok"}  ${label}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }

  console.log(failures ? `\n${failures} variant(s) don't match the preview.` : "\nEvery variant matches the preview.");
  if (failures) process.exitCode = 1;
};

main().catch((error: unknown) => {
  // Only the message: SDK errors can carry request details, including headers.
  console.error(`\n${errorMessage(error)}`);
  process.exitCode = 1;
});
