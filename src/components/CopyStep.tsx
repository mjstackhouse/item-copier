import { useEffect, useRef, useState } from "react";

import { type CopyResult, copyItems, type LogEntry } from "../lib/copy";
import { type Connection, editItemUrl } from "../lib/kontent";
import type { Plan } from "../lib/plan";
import type { PublishMode, WorkflowSteps } from "../lib/publishing";
import { buildReport } from "../lib/report";
import type { Selection } from "../lib/selection";
import { errorMessage, plural } from "../lib/util";
import { Message } from "./ui";

type Props = {
  readonly source: Connection;
  readonly target: Connection;
  readonly selection: Selection;
  readonly plan: Plan;
  readonly publishMode: PublishMode;
  readonly sourceWorkflowSteps: WorkflowSteps;
  readonly onStartOver: () => void;
};

export const CopyStep = ({ source, target, selection, plan, publishMode, sourceWorkflowSteps, onStartOver }: Props) => {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<CopyResult>();
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const started = useRef(false);
  const abort = useRef(new AbortController());
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Guard against React running the effect twice in development: the copy must only start once.
    if (started.current) return;
    started.current = true;

    copyItems({
      source,
      target,
      variants: plan.rows.map((r) => ({
        itemCodename: r.item.codename,
        languageCodename: r.languageCodename,
        targetWorkflowCodename: r.targetWorkflowCodename,
        liveInTarget: r.targetPublishing?.hasPublishedVersion,
      })),
      skipMissingReferences: selection.skipMissingReferences,
      publishMode,
      sourceWorkflowSteps,
      signal: abort.current.signal,
      onLog: (entry) => setLog((previous) => [...previous, entry]),
    })
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [source, target, selection, plan, publishMode, sourceWorkflowSteps]);

  // Runs on purpose whenever a log line is added, to keep the latest one in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: log.length is the trigger, not a value the effect reads
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [log.length]);

  const running = !result && !error;

  // Closing or reloading the tab stops the copy partway, so the browser asks first while it runs.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  const summary = result?.summary;
  const cancelled = result?.state === "cancelled";

  const cancel = () => {
    setCancelling(true);
    abort.current.abort();
  };

  const downloadReport = () => {
    const createdAt = new Date();
    const report = buildReport({
      source,
      target,
      selection,
      languageCodenames: [...new Set(plan.rows.map((r) => r.languageCodename))],
      publishMode,
      result,
      error,
      log,
      createdAt,
    });
    const url = URL.createObjectURL(new Blob([report], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `item-copier-report-${createdAt.toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <h2>
        {running
          ? cancelling
            ? "Cancelling…"
            : "Copying…"
          : error
            ? "Copy failed"
            : cancelled
              ? "Copy cancelled"
              : "Copy finished"}
      </h2>
      {running && !cancelling && <Message kind="warning">Keep this tab open until the copy finishes.</Message>}
      {running && cancelling && (
        <Message kind="warning">
          Stopping after the item that is being copied now, so no item is left half-copied. Keep this tab open.
        </Message>
      )}

      {/* Announces the outcome once, rather than every log line. */}
      <div role="status">
        {cancelled && !summary && (
          <Message kind="ok">The copy stopped before anything was written to the target.</Message>
        )}
        {cancelled && summary && (
          <Message kind="warning">
            The copy stopped partway. {plural(summary.variantsCancelled, "language variant")}{" "}
            {summary.variantsCancelled === 1 ? "was" : "were"} not copied. You can copy the same items again later:
            items that were already copied are updated, not duplicated.
          </Message>
        )}

        {summary && (
          <Message
            kind={
              summary.errors.length || summary.itemsNotRead.length || summary.assetsMovedToRoot.length
                ? "warning"
                : "ok"
            }
          >
            <p>
              Items: {summary.itemsOk} copied{summary.itemsFailed ? `, ${summary.itemsFailed} failed` : ""}. Language
              variants: {summary.variantsOk} copied
              {summary.variantsFailed ? `, ${summary.variantsFailed} failed` : ""}. Assets: {summary.assetsUploaded}{" "}
              uploaded, {summary.assetsUpdated} updated.
            </p>
            {summary.itemsNotRead.length > 0 && (
              <p>
                {plural(summary.itemsNotRead.length, "language variant")} could not be read from the source and{" "}
                {summary.itemsNotRead.length === 1 ? "was" : "were"} not copied: {summary.itemsNotRead.join(", ")}.
                Check them in the source, for example for a workflow step, collection or element value the copy can't
                handle.
              </p>
            )}
            {summary.assetsMovedToRoot.length > 0 && (
              <p>
                {plural(summary.assetsMovedToRoot.length, "asset")}{" "}
                {summary.assetsMovedToRoot.length === 1 ? "was" : "were"} placed in the root folder, because{" "}
                {summary.assetsMovedToRoot.length === 1 ? "its" : "their"} folder doesn't exist in the target:{" "}
                {summary.assetsMovedToRoot.join(", ")}. Move them, or create the folders and copy again.
              </p>
            )}
            {summary.errors.length > 0 && (
              <ul>
                {summary.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </Message>
        )}
        {error && (
          <Message kind="error" multiline>
            {error}
          </Message>
        )}
      </div>

      {summary && summary.copied.length > 0 && (
        <details className="card settings-card copied-list">
          <summary>
            <span className="section-heading">Copied language variants ({summary.copied.length})</span>
            <span className="muted">Open them in {target.environmentName}</span>
          </summary>
          <ul>
            {summary.copied.map((c) => (
              <li key={`${c.codename}-${c.languageCodename}`}>
                {c.targetItemId ? (
                  <a
                    href={editItemUrl(target.environmentId, c.languageCodename, c.targetItemId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}{" "}
                <span className="muted">{c.languageCodename}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section className="log-panel" aria-label="Progress log">
        <p className="section-heading">Progress log</p>
        <ol className="log">
          {log.map((entry) => (
            <li
              key={entry.id}
              className={entry.type === "error" ? "log-error" : entry.type === "warning" ? "log-warning" : ""}
            >
              <span className="muted">{entry.time.toLocaleTimeString()}</span> {entry.type && <code>{entry.type}</code>}{" "}
              {entry.message}
            </li>
          ))}
          <li ref={logEnd} />
        </ol>
      </section>

      <div className="actions">
        {running && (
          <button type="button" className="btn back-btn" disabled={cancelling} onClick={cancel}>
            {cancelling ? "Cancelling…" : "Cancel copy"}
          </button>
        )}
        {!running && (
          <button type="button" className="btn back-btn" onClick={downloadReport}>
            Download report
          </button>
        )}
        <button type="button" className="btn continue-btn" disabled={running} onClick={onStartOver}>
          Copy more items
        </button>
      </div>
    </section>
  );
};
