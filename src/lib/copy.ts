import { exportAsync, importAsync, type Logger, type LogMessage } from "@kontent-ai/migration-toolkit";

import { type Connection, errorMessage } from "./kontent";

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
  readonly itemCodenames: readonly string[];
  readonly languageCodename: string;
  readonly skipMissingReferences: boolean;
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
      exportItems: params.itemCodenames.map((itemCodename) => ({ itemCodename, languageCodename: params.languageCodename })),
    });
    if (params.signal.aborted) return { state: "cancelled" };

    phase = "import";
    const importResult = await importAsync({
      environmentId: params.target.environmentId,
      apiKey: params.target.apiKey,
      logger,
      data: migrationData,
    });

    const summary = summarize(importResult);
    return summary.variantsCancelled ? { state: "cancelled", summary } : { state: "finished", summary };
  } catch (error) {
    // Thrown before any import step ran (the export, or reading the target before writing).
    if (error instanceof CopyCancelledError) return { state: "cancelled" };
    // Toolkit errors carry terminal color codes; rethrow with a message the UI can show as is.
    throw new Error(stripColors(errorMessage(error)), { cause: error });
  }
};

const summarize = (importResult: Awaited<ReturnType<typeof importAsync>>): CopySummary => {
  const { contentItems, languageVariants, uploadedAssets, editedAssets } = importResult;
  // Each result is "valid", "error" or "404"; anything other than "valid" counts as failed,
  // unless it was skipped because of cancelling.
  const isCancelled = (r: { state: string; error?: unknown }) => r.error instanceof CopyCancelledError;
  const isFailed = (r: { state: string; error?: unknown }) => r.state !== "valid" && !isCancelled(r);
  const failed = [...contentItems, ...languageVariants, ...uploadedAssets, ...editedAssets].filter(isFailed);

  return {
    itemsOk: contentItems.filter((r) => r.state === "valid").length,
    itemsFailed: contentItems.filter(isFailed).length,
    variantsOk: languageVariants.filter((r) => r.state === "valid").length,
    variantsFailed: languageVariants.filter(isFailed).length,
    variantsCancelled: languageVariants.filter(isCancelled).length,
    assetsUploaded: uploadedAssets.filter((r) => r.state === "valid").length,
    assetsUpdated: editedAssets.filter((r) => r.state === "valid").length,
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
