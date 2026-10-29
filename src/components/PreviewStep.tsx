import { useEffect, useState } from "react";

import { errorMessage, type Connection, type SourceData } from "../lib/kontent";
import { buildPlan, type Plan } from "../lib/plan";
import { type LiveEffect, predict, type PublishMode } from "../lib/publishing";
import { Message } from "./ui";
import { languagesToCopy, type Selection } from "./SelectStep";

type Props = {
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly selection: Selection;
  readonly publishMode: PublishMode;
  readonly onPublishModeChange: (mode: PublishMode) => void;
  readonly onSkipMissingReferencesChange: (skip: boolean) => void;
  readonly onBack: () => void;
  readonly onConfirm: (plan: Plan) => void;
};

export const PreviewStep = ({
  source,
  target,
  sourceData,
  selection,
  publishMode,
  onPublishModeChange,
  onSkipMissingReferencesChange,
  onBack,
  onConfirm,
}: Props) => {
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
      languageCodenames: languagesToCopy(selection, sourceData.languages),
      linkedItemsDepth: selection.linkedItemsDepth,
      onProgress: (m) => !cancelled && setProgress(m),
    })
      .then((p) => !cancelled && setPlan(p))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // Only what the plan depends on: the skip option, for example, is set on this step and must not rebuild it.
  }, [
    source,
    target,
    sourceData,
    selection.pickedItems,
    selection.linkedItemsDepth,
    selection.copyAllLanguages,
    selection.chosenLanguages,
  ]);

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

  const rows = plan.rows.map((row) => ({
    row,
    prediction: row.sourcePublishing
      ? predict({
          mode: publishMode,
          source: row.sourcePublishing,
          target: row.targetPublishing,
          firstStepName: row.firstStepName,
        })
      : { outcome: "", effects: [] },
  }));
  const overwrites = plan.rows.filter((r) => r.targetStatus === "overwrites existing").length;
  const countEffect = (effect: LiveEffect) => rows.filter((r) => r.prediction.effects.includes(effect)).length;
  const goesLive = countEffect("goes live");
  const replacesLive = countEffect("replaces live content");
  const removedFromLive = countEffect("removed from live site");
  const schedulesReplaced = countEffect("schedule replaced");
  const schedulesCancelled = countEffect("schedule cancelled");
  const liveChanges = [
    removedFromLive > 0 &&
      `${removedFromLive} variant(s) will be unpublished and removed from the live site, because they are not published in the source.`,
    replacesLive > 0 && `${replacesLive} variant(s) will replace content that is live in the target, right away.`,
    goesLive > 0 && `${goesLive} variant(s) will be published and go live right away.`,
    schedulesReplaced > 0 &&
      `${schedulesReplaced} variant(s) have scheduled publishing in the target that will be cancelled and replaced with the source's.`,
    schedulesCancelled > 0 &&
      `${schedulesCancelled} variant(s) have scheduled publishing in the target that will be cancelled.`,
  ].filter((text): text is string => !!text);
  const confirmParts = [
    overwrites > 0 && `${overwrites} existing variant(s) will be overwritten`,
    removedFromLive > 0 && `${removedFromLive} variant(s) will be unpublished`,
    goesLive + replacesLive > 0 && `${goesLive + replacesLive} variant(s) will be published right away`,
  ].filter((text): text is string => !!text);
  // What needs confirming depends on the mode, so a change of mode asks for it again.
  const changeMode = (mode: PublishMode) => {
    setConfirmed(false);
    onPublishModeChange(mode);
  };
  const copied = languagesToCopy(selection, sourceData.languages);
  const languageSummary =
    copied.length > 5 ? `${copied.length} languages` : copied.join(", ");
  const itemCount = new Set(plan.rows.map((r) => r.id)).size;
  const variantCount = (id: string) => plan.rows.filter((r) => r.id === id).length;
  const namesById = new Map(plan.rows.map((r) => [r.id, r.item.name]));
  const nameOf = (id: string | undefined) => (id ? (namesById.get(id) ?? id) : "");

  return (
    <section>
      <h2>Preview</h2>
      <p>
        <strong>{itemCount}</strong> item(s) in <strong>{plan.rows.length}</strong> language variant(s) will be copied
        from <strong>{source.environmentName}</strong> to <strong>{target.environmentName}</strong> (
        {languageSummary}). Assets they use are copied too.
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
      {plan.deletedReferenceCount > 0 && (
        <Message kind="warning">
          <p>
            {plan.deletedReferenceCount} reference(s) point to items that no longer exist in the source. The copy fails on
            them unless they are skipped.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={selection.skipMissingReferences}
              onChange={(e) => onSkipMissingReferencesChange(e.target.checked)}
            />
            Skip these references when copying
          </label>
        </Message>
      )}

      <fieldset className="publish-mode">
        <legend className="section-heading">Publishing</legend>
        <label className="checkbox">
          <input
            type="radio"
            name="publish-mode"
            checked={publishMode === "match"}
            onChange={() => changeMode("match")}
          />
          <span>
            <strong>Match the source</strong>
            <span className="muted">
              Items published in the source are published in the target, items not published in the source are
              unpublished there, and schedules are copied.
            </span>
          </span>
        </label>
        <label className="checkbox">
          <input
            type="radio"
            name="publish-mode"
            checked={publishMode === "drafts"}
            onChange={() => changeMode("drafts")}
          />
          <span>
            <strong>Copy as drafts</strong>
            <span className="muted">
              Nothing is published or unpublished. Items that are live in the target stay live, with the copied
              content as a new draft on top. Schedules are not copied.
            </span>
          </span>
        </label>
      </fieldset>

      {liveChanges.length > 0 && (
        <Message kind="warning">
          <p>
            {publishMode === "match" ? (
              <>
                The copy makes each item's publishing state in <strong>{target.environmentName}</strong> match the
                source:
              </>
            ) : (
              <>
                Nothing will be published or unpublished in <strong>{target.environmentName}</strong>, but:
              </>
            )}
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
              <th>Language</th>
              <th>Why</th>
              <th>In target</th>
              <th>After copy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, prediction }, index) => (
              <tr key={`${row.id}-${row.languageCodename}`}>
                {/* An item's variants are next to each other; its name and type span them. */}
                {rows[index - 1]?.row.id !== row.id && (
                  <>
                    <td rowSpan={variantCount(row.id)}>
                      {row.item.name}
                      <div className="muted">{row.item.codename}</div>
                    </td>
                    <td rowSpan={variantCount(row.id)}>{row.typeCodename}</td>
                  </>
                )}
                <td>{row.languageCodename}</td>
                <td>{row.depth === 0 ? "Selected" : `Linked from ${nameOf(row.linkedFrom)}`}</td>
                <td>
                  <span className={`badge ${row.targetStatus === "overwrites existing" ? "badge-warn" : ""}`}>
                    {row.targetStatus}
                  </span>
                </td>
                <td>
                  {prediction.outcome}
                  {prediction.effects.length > 0 && (
                    <div className="badges">
                      {prediction.effects.map((effect) => (
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
          disabled={
            plan.blockers.length > 0 ||
            (confirmParts.length > 0 && !confirmed) ||
            (plan.deletedReferenceCount > 0 && !selection.skipMissingReferences)
          }
          onClick={() => onConfirm(plan)}
        >
          Copy {plan.rows.length} variant(s)
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
  "schedule cancelled": "badge-warn",
};
