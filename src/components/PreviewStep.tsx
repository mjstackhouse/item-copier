import { useEffect, useState } from "react";

import { errorMessage, type Connection, type SourceData } from "../lib/kontent";
import { buildPlan, type Plan } from "../lib/plan";
import type { LiveEffect } from "../lib/publishing";
import { Message } from "./ui";
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
        <Message kind="error">Could not build the preview: {error}</Message>
        <div className="actions">
          <button type="button" className="btn back-btn" onClick={onBack}>
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
        <p className="loading-general" role="status">
          {progress}
        </p>
      </section>
    );
  }

  const overwrites = plan.rows.filter((r) => r.targetStatus === "overwrites existing").length;
  const countEffect = (effect: LiveEffect) => plan.rows.filter((r) => r.effects.includes(effect)).length;
  const goesLive = countEffect("goes live");
  const replacesLive = countEffect("replaces live content");
  const removedFromLive = countEffect("removed from live site");
  const schedulesReplaced = countEffect("schedule replaced");
  const liveChanges = [
    removedFromLive > 0 &&
      `${removedFromLive} item(s) will be unpublished and removed from the live site, because they are not published in the source.`,
    replacesLive > 0 && `${replacesLive} item(s) will replace content that is live in the target, right away.`,
    goesLive > 0 && `${goesLive} item(s) will be published and go live right away.`,
    schedulesReplaced > 0 &&
      `${schedulesReplaced} item(s) have scheduled publishing in the target that will be cancelled and replaced with the source's.`,
  ].filter((text): text is string => !!text);
  const confirmParts = [
    overwrites > 0 && `${overwrites} existing item(s) will be overwritten`,
    removedFromLive > 0 && `${removedFromLive} item(s) will be unpublished`,
    goesLive + replacesLive > 0 && `${goesLive + replacesLive} item(s) will be published right away`,
  ].filter((text): text is string => !!text);
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
        <Message key={b} kind="error">
          {b}
        </Message>
      ))}
      {plan.warnings.map((w) => (
        <Message key={w} kind="warning">
          {w}
        </Message>
      ))}

      {liveChanges.length > 0 && (
        <Message kind="warning">
          <p>
            The copy makes each item's publishing state in <strong>{target.environmentName}</strong> match the source:
          </p>
          <ul>
            {liveChanges.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Message>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Why</th>
              <th>In target</th>
              <th>After copy</th>
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
                <td>
                  {row.outcome}
                  {row.effects.length > 0 && (
                    <div className="badges">
                      {row.effects.map((effect) => (
                        <span key={effect} className={`badge ${effectBadgeClass[effect]}`}>
                          {effect}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmParts.length > 0 && (
        <label className="checkbox confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I understand
          that in {target.environmentName}, {confirmParts.join(", ")}.
        </label>
      )}

      <div className="actions">
        <button type="button" className="btn back-btn" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn continue-btn"
          disabled={plan.blockers.length > 0 || (confirmParts.length > 0 && !confirmed)}
          onClick={() => onConfirm(plan)}
        >
          Copy {plan.rows.length} item(s)
        </button>
      </div>
    </section>
  );
};

const effectBadgeClass: Record<LiveEffect, string> = {
  "goes live": "",
  "replaces live content": "badge-warn",
  "removed from live site": "badge-danger",
  "schedule replaced": "badge-warn",
};
