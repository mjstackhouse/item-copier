import { useEffect, useRef, useState } from "react";

import { type CopyResult, copyItems, type LogEntry } from "../lib/copy";
import { type Connection, errorMessage } from "../lib/kontent";
import type { Plan } from "../lib/plan";
import type { Selection } from "./SelectStep";

type Props = {
  readonly source: Connection;
  readonly target: Connection;
  readonly selection: Selection;
  readonly plan: Plan;
  readonly onStartOver: () => void;
};

export const CopyStep = ({ source, target, selection, plan, onStartOver }: Props) => {
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
      itemCodenames: plan.rows.map((r) => r.item.codename),
      languageCodename: selection.languageCodename,
      skipMissingReferences: selection.skipMissingReferences,
      signal: abort.current.signal,
      onLog: (entry) => setLog((previous) => [...previous, entry]),
    })
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [source, target, selection, plan]);

  // Braces matter: an effect's return value is treated as its cleanup function.
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [log.length]);

  const running = !result && !error;
  const summary = result?.summary;
  const cancelled = result?.state === "cancelled";

  const cancel = () => {
    setCancelling(true);
    abort.current.abort();
  };

  return (
    <section>
      <h2>
        {running ? (cancelling ? "Cancelling…" : "Copying…") : error ? "Copy failed" : cancelled ? "Copy cancelled" : "Copy finished"}
      </h2>
      {running && !cancelling && <p className="message warning">Keep this tab open until the copy finishes.</p>}
      {running && cancelling && (
        <p className="message warning">
          Stopping after the item that is being copied now, so no item is left half-copied. Keep this tab open.
        </p>
      )}

      {cancelled && !summary && (
        <p className="message ok">The copy stopped before anything was written to the target.</p>
      )}
      {cancelled && summary && (
        <p className="message warning">
          The copy stopped partway. {summary.variantsCancelled} language variant(s) were not copied. You can copy the
          same items again later: items that were already copied are updated, not duplicated.
        </p>
      )}

      {summary && (
        <div className={`message ${summary.errors.length || summary.itemsNotRead.length ? "warning" : "ok"}`}>
          <p>
            Items: {summary.itemsOk} copied{summary.itemsFailed ? `, ${summary.itemsFailed} failed` : ""}. Language
            variants: {summary.variantsOk} copied
            {summary.variantsFailed ? `, ${summary.variantsFailed} failed` : ""}. Assets: {summary.assetsUploaded}{" "}
            uploaded, {summary.assetsUpdated} updated.
          </p>
          {summary.itemsNotRead.length > 0 && (
            <p>
              {summary.itemsNotRead.length} item(s) could not be read from the source and were not copied:{" "}
              {summary.itemsNotRead.join(", ")}. Check them in the source, for example for a workflow step, collection
              or element value the copy can't handle.
            </p>
          )}
          {summary.errors.length > 0 && (
            <ul>
              {summary.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="message error multiline">{error}</p>}

      <ol className="log" aria-live="polite">
        {log.map((entry, index) => (
          <li key={index} className={entry.type === "error" ? "log-error" : entry.type === "warning" ? "log-warning" : ""}>
            <span className="muted">{entry.time.toLocaleTimeString()}</span> {entry.type && <code>{entry.type}</code>}{" "}
            {entry.message}
          </li>
        ))}
        <li ref={logEnd} />
      </ol>

      <div className="actions">
        {running && (
          <button type="button" disabled={cancelling} onClick={cancel}>
            {cancelling ? "Cancelling…" : "Cancel copy"}
          </button>
        )}
        <button type="button" className="primary" disabled={running} onClick={onStartOver}>
          Copy more items
        </button>
      </div>
    </section>
  );
};
