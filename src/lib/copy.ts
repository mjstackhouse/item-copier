import { exportAsync, importAsync, type Logger, type LogMessage, type MigrationData } from "@kontent-ai/migration-toolkit";

import { type Connection, errorMessage } from "./kontent";
import { firstSteps, loadWorkflowSteps, type PublishMode, targetStepFor, type WorkflowSteps } from "./publishing";

export type LogEntry = LogMessage & { readonly time: Date };

export type CopySummary = {
  readonly itemsOk: number;
  readonly itemsFailed: number;
  readonly variantsOk: number;
  readonly variantsFailed: number;
  /** Language variants that were not copied because the copy was cancelled. */
  readonly variantsCancelled: number;
  readonly assetsUploaded: number;
  readonly assetsUpdated: number;
  /**
   * Language variants (as "codename (language)") the toolkit could not read from the source. It skips
   * those without reporting an error, so they are found by comparing what was read with what was requested.
   */
  readonly itemsNotRead: readonly string[];
  /**
   * Assets (as "codename (folder)") placed in the target's root folder because their source folder
   * doesn't exist in the target. Cloning an environment without content items and assets doesn't copy
   * asset folders, and the toolkit fails an asset whose folder is missing.
   */
  readonly assetsMovedToRoot: readonly string[];
  readonly errors: readonly string[];
};

export type CopyResult =
  | { readonly state: "finished"; readonly summary: CopySummary }
  /** `summary` is undefined when the copy stopped before anything was written to the target. */
  | { readonly state: "cancelled"; readonly summary?: CopySummary };

/** Thrown from the logger to stop the toolkit once the user cancels. */
class CopyCancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

// The log types the toolkit uses right before it sends a Management API request.
const requestLogTypes = new Set<LogMessage["type"]>([
  "list",
  "view",
  "archive",
  "unpublish",
  "changeWorkflowStep",
  "publish",
  "upload",
  "create",
  "upsert",
  "schedulePublish",
  "scheduleUnpublish",
  "cancelScheduledPublish",
  "cancelScheduledUnpublish",
  "createNewVersion",
]);

/**
 * Copies the items with the migration toolkit, sending every log line to `onLog`.
 * When `signal` is aborted, the copy stops at the next safe point: during the export anywhere
 * (nothing has been written yet), during the import before the next item starts, so no item
 * is left half-imported.
 */
export const copyItems = async (params: {
  readonly source: Connection;
  readonly target: Connection;
  /** The language variants to copy; the toolkit copies all of them in one run. */
  readonly variants: readonly { readonly itemCodename: string; readonly languageCodename: string }[];
  readonly skipMissingReferences: boolean;
  readonly publishMode: PublishMode;
  /** The source environment's workflow steps, needed to turn versions into drafts. */
  readonly sourceWorkflowSteps: WorkflowSteps;
  readonly signal: AbortSignal;
  readonly onLog: (entry: LogEntry) => void;
}): Promise<CopyResult> => {
  let phase: "export" | "import" = "export";
  // True between items: before the first request of an item and after the toolkit reports one done.
  let atItemBoundary = true;

  // The toolkit colors parts of its messages with terminal color codes; strip them for the UI.
  const push = (message: LogMessage) =>
    params.onLog({ ...message, message: stripColors(message.message), time: new Date() });

  const checkCancelled = (message: LogMessage & { readonly prefix?: string }) => {
    if (!params.signal.aborted) return;
    if (phase === "export") throw new CopyCancelledError();

    // Progress lines (they carry a percentage prefix) are logged after an item finishes.
    if (message.prefix !== undefined) {
      atItemBoundary = true;
      return;
    }
    if (requestLogTypes.has(message.type) && atItemBoundary) throw new CopyCancelledError();
  };

  const trackBoundary = (message: LogMessage & { readonly prefix?: string }) => {
    if (message.prefix !== undefined) atItemBoundary = true;
    else if (requestLogTypes.has(message.type)) atItemBoundary = false;
  };

  // Passing our own logger keeps the toolkit away from its terminal logger,
  // lets the UI show progress as it happens, and is where cancelling takes effect.
  const logger: Logger = {
    log: (message) => {
      checkCancelled(message);
      trackBoundary(message);
      push(message);
    },
    logWithSpinnerAsync: async (func) =>
      func((m) => {
        checkCancelled(m);
        trackBoundary(m);
        push({ ...m, message: m.prefix ? `${m.prefix} ${m.message}` : m.message });
      }),
  };

  try {
    // These two calls are what the toolkit's migrateAsync does; running them separately
    // guarantees that cancelling during the export never writes to the target.
    const migrationData = await exportAsync({
      environmentId: params.source.environmentId,
      apiKey: params.source.apiKey,
      logger,
      skipMissingReferences: params.skipMissingReferences,
      exportItems: params.variants.map((v) => ({ itemCodename: v.itemCodename, languageCodename: v.languageCodename })),
    });
    if (params.signal.aborted) return { state: "cancelled" };

    const key = (itemCodename: string, languageCodename: string) => `${itemCodename} (${languageCodename})`;
    const read = new Set(migrationData.items.map((i) => key(i.system.codename, i.system.language.codename)));
    const itemsNotRead = params.variants
      .map((v) => key(v.itemCodename, v.languageCodename))
      .filter((k) => !read.has(k));

    const published = params.publishMode === "drafts" ? toDrafts(migrationData, params.sourceWorkflowSteps) : migrationData;
    const fitted = fitStepsToTarget(published, params.sourceWorkflowSteps, await loadWorkflowSteps(params.target.client));
    const { data, movedToRoot } = await withExistingFolders(fitted, params.target);
    if (params.signal.aborted) return { state: "cancelled" };

    phase = "import";
    const importResult = await importAsync({
      environmentId: params.target.environmentId,
      apiKey: params.target.apiKey,
      logger,
      data,
    });

    const summary = summarize(importResult, itemsNotRead, movedToRoot);
    return summary.variantsCancelled ? { state: "cancelled", summary } : { state: "finished", summary };
  } catch (error) {
    // Thrown before any import step ran (the export, or reading the target before writing).
    if (error instanceof CopyCancelledError) return { state: "cancelled" };
    // Toolkit errors carry terminal color codes; rethrow with a message the UI can show as is.
    throw new Error(stripColors(errorMessage(error)), { cause: error });
  }
};

/**
 * Rewrites the exported data so the import publishes nothing: the published version is dropped when
 * there is a newer draft, and any published, scheduled or archived version moves to the workflow's
 * first step without a schedule. `keepTargetPublished` is read by this app's patch to the toolkit
 * (see patches/), which otherwise unpublishes target items whose import data has no published version.
 */
const toDrafts = (data: MigrationData, steps: WorkflowSteps): MigrationData => {
  const first = firstSteps(steps);
  const stepKind = (workflowCodename: string, stepCodename: string) =>
    [...steps.values()].find((s) => s.workflowCodename === workflowCodename && s.codename === stepCodename)?.kind ??
    "draft";

  return {
    ...data,
    items: data.items.map((item) => {
      const workflow = item.system.workflow.codename;
      const firstStep = first.get(workflow)?.codename;
      const drafts = item.versions.filter((v) => stepKind(workflow, v.workflow_step.codename) !== "published");
      const versions = (drafts.length ? drafts : item.versions).map((v) => ({
        ...v,
        workflow_step:
          stepKind(workflow, v.workflow_step.codename) === "draft" || !firstStep ? v.workflow_step : { codename: firstStep },
        schedule: undefined,
      }));
      return { ...item, versions, keepTargetPublished: true };
    }),
  };
};

/**
 * The toolkit puts each version in the step with the same codename in the target's workflow, and fails
 * when that step doesn't exist there (for example a step added after the environment was cloned). Such
 * versions move to the target workflow's step of the same kind, or its first step (see `targetStepFor`);
 * the preview tells the user. A missing workflow is left alone: the preview blocks the copy for it.
 */
const fitStepsToTarget = (data: MigrationData, sourceSteps: WorkflowSteps, targetSteps: WorkflowSteps): MigrationData => ({
  ...data,
  items: data.items.map((item) => {
    const workflow = item.system.workflow.codename;
    const versions = item.versions.map((v) => {
      const kind =
        [...sourceSteps.values()].find((s) => s.workflowCodename === workflow && s.codename === v.workflow_step.codename)
          ?.kind ?? "draft";
      const step = targetStepFor(targetSteps, workflow, { codename: v.workflow_step.codename, kind });
      return step && step.codename !== v.workflow_step.codename ? { ...v, workflow_step: { codename: step.codename } } : v;
    });
    return { ...item, versions };
  }),
});

/**
 * The toolkit puts each asset in the target folder with the same codename as in the source, and the
 * Management API rejects the asset if that folder doesn't exist. This happens after cloning an environment
 * without content items and assets, which doesn't copy asset folders. Such assets go to the root folder
 * instead (by leaving the folder out), and are reported in the summary.
 */
const withExistingFolders = async (
  data: MigrationData,
  target: Connection,
): Promise<{ readonly data: MigrationData; readonly movedToRoot: readonly MovedAsset[] }> => {
  if (!data.assets.some((a) => a.folder)) return { data, movedToRoot: [] };

  const folders = (await target.client.listAssetFolders().toPromise()).data.items;
  const codenames = new Set<string>();
  const collect = (list: readonly { codename: string; folders: readonly unknown[] }[]) => {
    for (const folder of list) {
      codenames.add(folder.codename);
      collect(folder.folders as typeof list);
    }
  };
  collect(folders);

  const movedToRoot: MovedAsset[] = [];
  const assets = data.assets.map((asset) => {
    if (!asset.folder?.codename || codenames.has(asset.folder.codename)) return asset;
    movedToRoot.push({ codename: asset.codename, folder: asset.folder.codename });
    return { ...asset, folder: undefined };
  });
  return { data: { ...data, assets }, movedToRoot };
};

type MovedAsset = { readonly codename: string; readonly folder: string };

const summarize = (
  importResult: Awaited<ReturnType<typeof importAsync>>,
  itemsNotRead: readonly string[],
  movedToRoot: readonly MovedAsset[],
): CopySummary => {
  const { contentItems, languageVariants, uploadedAssets, editedAssets } = importResult;
  // Each result is "valid", "error" or "404"; anything other than "valid" counts as failed,
  // unless it was skipped because of cancelling.
  const isCancelled = (r: { state: string; error?: unknown }) => r.error instanceof CopyCancelledError;
  const isFailed = (r: { state: string; error?: unknown }) => r.state !== "valid" && !isCancelled(r);
  const failed = [...contentItems, ...languageVariants, ...uploadedAssets, ...editedAssets].filter(isFailed);
  const written = new Set([
    ...uploadedAssets.filter((r) => r.state === "valid").map((r) => r.inputItem.codename),
    ...editedAssets.filter((r) => r.state === "valid").map((r) => r.inputItem.migrationAsset.codename),
  ]);

  return {
    itemsOk: contentItems.filter((r) => r.state === "valid").length,
    itemsFailed: contentItems.filter(isFailed).length,
    variantsOk: languageVariants.filter((r) => r.state === "valid").length,
    variantsFailed: languageVariants.filter(isFailed).length,
    variantsCancelled: languageVariants.filter(isCancelled).length,
    assetsUploaded: uploadedAssets.filter((r) => r.state === "valid").length,
    assetsUpdated: editedAssets.filter((r) => r.state === "valid").length,
    itemsNotRead,
    // Only assets this copy actually created or updated: one already in the target is left where it is.
    assetsMovedToRoot: movedToRoot
      .filter(({ codename }) => written.has(codename))
      .map(({ codename, folder }) => `${codename} (${folder})`),
    errors: failed.map((r) => describeError(r)),
  };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal color codes on purpose
const stripColors = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const describeError = (result: unknown): string => {
  const r = result as {
    state: string;
    error?: unknown;
    inputItem?: { system?: { codename?: string }; codename?: string; migrationAsset?: { codename?: string } };
  };
  const name = r.inputItem?.system?.codename ?? r.inputItem?.codename ?? r.inputItem?.migrationAsset?.codename ?? "unknown";
  if (r.state === "404") return `${name}: not found`;
  const message =
    r.error && typeof r.error === "object" && "message" in r.error ? String(r.error.message) : String(r.error);
  return stripColors(`${name}: ${message}`);
};
