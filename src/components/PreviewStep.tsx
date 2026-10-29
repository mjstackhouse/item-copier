import { useEffect, useState } from "react";

import { errorMessage, type Connection, type SourceData } from "../lib/kontent";
import { buildPlan, type Plan } from "../lib/plan";
import type { Selection } from "./SelectStep";

type Props = {
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly selection: Selection;
  readonly onBack: () => void;
  readonly onConfirm: (plan: Plan) => void;
};

export const PreviewStep = ({ source, target, sourceData, selection, onBack, onConfirm }: Props) => {
  const [plan, setPlan] = useState<Plan>();
  const [progress, setProgress] = useState("Starting");
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    buildPlan({
      source,
      target,
      sourceData,
      pickedIds: selection.pickedItems.map((i) => i.id),
      languageCodename: selection.languageCodename,
      linkedItemsDepth: selection.linkedItemsDepth,
      skipMissingReferences: selection.skipMissingReferences,
      onProgress: (m) => !cancelled && setProgress(m),
    })
      .then((p) => !cancelled && setPlan(p))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [source, target, sourceData, selection]);

  if (error) {
    return (
      <section>
        <h2>Preview</h2>
        <p className="message error">Could not build the preview: {error}</p>
        <div className="actions">
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </section>
    );
  }

  if (!plan) {
    return (
      <section>
        <h2>Preview</h2>
        <p className="muted" aria-live="polite">
          {progress}…
        </p>
      </section>
    );
  }

  const overwrites = plan.rows.filter((r) => r.targetStatus === "overwrites existing").length;
  const namesById = new Map(plan.rows.map((r) => [r.id, r.item.name]));
  const nameOf = (id: string | undefined) => (id ? (namesById.get(id) ?? id) : "");

  return (
    <section>
      <h2>Preview</h2>
      <p>
        <strong>{plan.rows.length}</strong> item(s) will be copied from <strong>{source.environmentName}</strong> to{" "}
        <strong>{target.environmentName}</strong> in <strong>{selection.languageCodename}</strong>. Assets they use are
        copied too.
      </p>

      {plan.blockers.map((b) => (
        <p key={b} className="message error">
          {b}
        </p>
      ))}
      {plan.warnings.map((w) => (
        <p key={w} className="message warning">
          {w}
        </p>
      ))}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Why</th>
              <th>In target</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.item.name}
                  <div className="muted">{row.item.codename}</div>
                </td>
                <td>{row.typeCodename}</td>
                <td>{row.depth === 0 ? "Selected" : `Linked from ${nameOf(row.linkedFrom)}`}</td>
                <td>
                  <span className={`badge ${row.targetStatus === "overwrites existing" ? "badge-warn" : ""}`}>
                    {row.targetStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {overwrites > 0 && (
        <label className="checkbox confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I understand
          that {overwrites} existing item(s) in the target will be overwritten.
        </label>
      )}

      <div className="actions">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="primary"
          disabled={plan.blockers.length > 0 || (overwrites > 0 && !confirmed)}
          onClick={() => onConfirm(plan)}
        >
          Copy {plan.rows.length} item(s)
        </button>
      </div>
    </section>
  );
};
