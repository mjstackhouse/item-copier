import { useEffect, useId, useRef, useState } from "react";

import { type KontentSelection, loadSelectedItems, selectionChange, selectionKey } from "../lib/customApp";
import type { Connection, Item, SourceData } from "../lib/kontent";
import { buildPlan, type Plan, type PlanRow, predictRow, publishModeBlockers, type TargetStatus } from "../lib/plan";
import type { LiveEffect, Prediction, PublishMode } from "../lib/publishing";
import { groupByItem, type ItemResults, type Result } from "../lib/itemResults";
import { languagesToCopy, type Selection } from "../lib/selection";
import { errorMessage, plural, unique } from "../lib/util";
import { Codename, Message } from "./ui";

type Props = {
  readonly source: Connection;
  readonly target: Connection;
  readonly sourceData: SourceData;
  readonly selection: Selection;
  readonly publishMode: PublishMode;
  /** In a Kontent.ai dialog, which closing stops a copy, rather than a browser tab. */
  readonly inDialog: boolean;
  /** In a dialog: what is selected in Kontent.ai now, which may have changed since Choose items. */
  readonly kontentSelection?: KontentSelection;
  readonly onPickedItemsChange: (items: readonly Item[], fromKey: string) => void;
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
  inDialog,
  kontentSelection,
  onPickedItemsChange,
  onPublishModeChange,
  onSkipMissingReferencesChange,
  onBack,
  onConfirm,
}: Props) => {
  const [plan, setPlan] = useState<Plan>();
  const [progress, setProgress] = useState("Starting");
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("all");
  const [updating, setUpdating] = useState<{ readonly loading?: boolean; readonly error?: string }>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  // Only what the plan depends on: the skip option, for example, is set on this step and must not rebuild it.
  const { pickedItems, linkedItemsDepth, copyAllLanguages, chosenLanguages } = selection;
  useEffect(() => {
    let cancelled = false;
    // A rebuild (after "Update preview") shows its progress rather than the old preview.
    setPlan(undefined);
    setError(undefined);
    setProgress("Starting");
    buildPlan({
      source,
      target,
      sourceData,
      pickedIds: pickedItems.map((i) => i.id),
      languageCodenames: languagesToCopy({ copyAllLanguages, chosenLanguages }, sourceData.languages),
      linkedItemsDepth,
      onProgress: (m) => !cancelled && setProgress(m),
    })
      .then((p) => !cancelled && setPlan(p))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [source, target, sourceData, pickedItems, linkedItemsDepth, copyAllLanguages, chosenLanguages]);

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

  const rows = plan.rows.map((row) => ({ row, prediction: predictRow(row, publishMode) }));
  const blockers = [...plan.blockers, ...publishModeBlockers(plan, publishMode)];
  const overwrites = plan.rows.filter((r) => r.targetStatus === "overwrites existing").length;
  const countEffect = (effect: LiveEffect) => rows.filter((r) => r.prediction.effects.includes(effect)).length;
  const goesLive = countEffect("goes live");
  const replacesLive = countEffect("replaces live content");
  const unpublished = countEffect("unpublished");
  const schedulesReplaced = countEffect("schedule replaced");
  const schedulesCancelled = countEffect("schedule cancelled");
  // What the confirmation dialog lists; without any of these, Copy starts right away.
  const consequences = [
    overwrites > 0 && `${plural(overwrites, "existing variant")} will be overwritten.`,
    goesLive > 0 && `${plural(goesLive, "variant")} will be published right away.`,
    replacesLive > 0 &&
      `${plural(replacesLive, "variant")} will replace ${replacesLive === 1 ? "its" : "their"} published ${replacesLive === 1 ? "version" : "versions"} right away.`,
    unpublished > 0 &&
      `${plural(unpublished, "variant")} will be unpublished, because ${unpublished === 1 ? "it isn't" : "they aren't"} published in the source.`,
    schedulesReplaced > 0 &&
      `${plural(schedulesReplaced, "scheduled publishing")} will be cancelled and replaced with the source's.`,
    schedulesCancelled > 0 && `${plural(schedulesCancelled, "scheduled publishing")} will be cancelled.`,
  ].filter((text): text is string => !!text);

  const itemCount = new Set(plan.rows.map((r) => r.id)).size;
  // Names as in the Kontent.ai app; codenames are behind a {#} icon, as there.
  const languageNames = new Map(sourceData.languages.map((l) => [l.codename, l.name]));
  const languageName = (codename: string) => languageNames.get(codename) ?? codename;
  const copiedLanguages = unique(plan.rows.map((r) => r.languageCodename));
  const languageSummary =
    copiedLanguages.length > 3
      ? plural(copiedLanguages.length, "language")
      : copiedLanguages.map(languageName).join(", ");
  const newVariants = plan.rows.length - overwrites;
  const mixedItems = groupByItem(rows).filter((i) => i.otherResults > 0).length;
  const summaryParts = [
    `${plural(itemCount, "item")} in ${plural(plan.rows.length, "language variant")} (${languageSummary})`,
    newVariants > 0 && `${newVariants} new`,
    overwrites > 0 && `${overwrites} ${overwrites === 1 ? "overwrites" : "overwrite"} existing`,
    goesLive > 0 && `${goesLive} published`,
    replacesLive > 0 && `${replacesLive} ${replacesLive === 1 ? "replaces its" : "replace their"} published version`,
    unpublished > 0 && `${unpublished} unpublished`,
    // The dialog lists items with one result each, so it says which items to open for the rest.
    inDialog && mixedItems > 0 && `${plural(mixedItems, "item")} with different results per language`,
  ].filter((text): text is string => !!text);

  const missingReferences = [
    plan.deletedReferenceCount > 0 &&
      plural(plan.deletedReferenceCount, "reference to a deleted item", "references to deleted items"),
    plan.missingAssetCount > 0 &&
      plural(plan.missingAssetCount, "reference to a deleted asset", "references to deleted assets"),
  ]
    .filter((text): text is string => !!text)
    .join(" and ");
  // Grouped by item: listing every variant would repeat long item names once per missing language.
  const skippedGroups = new Map<string, { name: string; languages: string[] }>();
  for (const v of plan.skippedVariants) {
    const group = skippedGroups.get(v.itemId) ?? { name: v.itemName, languages: [] };
    group.languages.push(v.languageCodename);
    skippedGroups.set(v.itemId, group);
  }
  const skippedByItem = [...skippedGroups.entries()].map(([id, group]) => ({ id, ...group }));
  const noteCount =
    plan.notes.length +
    (skippedByItem.length > 0 ? 1 : 0) +
    (plan.rows.length > largeCopy ? 1 : 0) +
    (missingReferences && selection.skipMissingReferences ? 1 : 0);

  // Why the Copy button is disabled, shown next to it.
  const blockedBy =
    blockers.length > 0
      ? "Fix the errors above to copy."
      : missingReferences && !selection.skipMissingReferences
        ? "Skip the missing references above to copy."
        : undefined;

  const filters = rowFilters.filter(
    (f) => f.id === "all" || rows.some(({ row, prediction }) => f.matches(row, prediction)),
  );
  // A filter can stop matching anything when the publishing option changes.
  const activeFilter = filters.find((f) => f.id === filter) ?? rowFilters[0];
  const shownRows = rows.filter(({ row, prediction }) => activeFilter.matches(row, prediction));
  const variantCount = (id: string) => shownRows.filter(({ row }) => row.id === id).length;
  const namesById = new Map(plan.rows.map((r) => [r.id, r.item.name]));

  // The copy uses the reviewed items, so a changed selection is pointed out, never applied without asking.
  const changed =
    kontentSelection &&
    selectionChange({ ids: pickedItems.map((i) => i.id), key: selection.pickedFromKey }, kontentSelection);
  const updatePreview = (selected: KontentSelection) => {
    setUpdating({ loading: true });
    loadSelectedItems(source.client, selected, selection.languageCodename)
      .then((items) => {
        setUpdating({});
        onPickedItemsChange(items, selectionKey(selected));
      })
      .catch((e: unknown) => setUpdating({ error: `Could not load the selected items: ${errorMessage(e)}` }));
  };

  const startCopy = () => (consequences.length > 0 || changed ? dialog.current?.showModal() : onConfirm(plan));

  return (
    <section>
      <h2>Preview</h2>
      <p className="preview-summary">
        <strong>
          {source.environmentName} → {target.environmentName}
        </strong>
        {summaryParts.map((part) => (
          <span key={part}> · {part}</span>
        ))}
      </p>

      {changed && (
        <Message kind="warning">
          {changed.empty ? (
            <p>Nothing is selected in Kontent.ai now. The copy uses the items in this preview.</p>
          ) : (
            <>
              <p>
                The selection in Kontent.ai has changed since this preview
                {changed.counts &&
                  ` (${[
                    changed.counts.added > 0 && `${plural(changed.counts.added, "item")} added`,
                    changed.counts.removed > 0 && `${plural(changed.counts.removed, "item")} removed`,
                  ]
                    .filter(Boolean)
                    .join(", ")})`}
                . {/* A text link at the end of the sentence, like "Show details", so the notice stays compact. */}
                <button
                  type="button"
                  className="message-action"
                  disabled={updating.loading}
                  onClick={() => kontentSelection && updatePreview(kontentSelection)}
                >
                  {updating.loading ? "Updating preview…" : "Update preview"}
                </button>
              </p>
              {updating.error && <p>{updating.error}</p>}
            </>
          )}
        </Message>
      )}
      {blockers.map((b) => (
        <Message key={b} kind="error">
          {b}
        </Message>
      ))}
      {missingReferences && !selection.skipMissingReferences && (
        <Message kind="warning">
          <p>
            The items to copy contain {missingReferences}. The copy stops on them unless they are skipped, which leaves
            them out of the copied content.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={false} onChange={() => onSkipMissingReferencesChange(true)} />
            Skip missing references
          </label>
        </Message>
      )}
      {noteCount > 0 && (
        <Message kind="info">
          <details>
            <summary>
              More information about this copy ({noteCount})
              {/* The text ("Show details" / "Hide details") comes from CSS, following the open state. */}
              <span className="details-toggle" />
            </summary>
            <ul>
              {missingReferences && selection.skipMissingReferences && (
                <li>
                  {missingReferences.charAt(0).toUpperCase() + missingReferences.slice(1)} will be left out of the
                  copied content (Skip missing references is on).
                </li>
              )}
              {plan.rows.length > largeCopy && (
                <li>
                  This is a large copy. It runs in this {inDialog ? "dialog" : "tab"} and can take a while, so keep the{" "}
                  {inDialog ? "dialog" : "tab"} open until it finishes. If the linked items depth pulled in more than
                  you need, go back and lower it.
                </li>
              )}
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {skippedByItem.length > 0 && (
                <li>
                  {plural(plan.skippedVariants.length, "language variant")} with no content in the source{" "}
                  {plan.skippedVariants.length === 1 ? "is" : "are"} skipped:
                  <ul>
                    {skippedByItem.map(({ id, name, languages }) => (
                      <li key={id}>
                        <strong>{name}:</strong> {listLanguages(languages)}
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </details>
        </Message>
      )}

      <fieldset className="publish-mode">
        <legend className="section-heading">Publishing</legend>
        <div className="publish-options">
          {publishOptions.map((option) => (
            <label
              key={option.mode}
              className={`checkbox publish-option ${publishMode === option.mode ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="publish-mode"
                checked={publishMode === option.mode}
                onChange={() => onPublishModeChange(option.mode)}
              />
              <span>
                <strong>{option.title}</strong>
                <span className="muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {filters.length > 2 && (
        <fieldset className="row-filters">
          <legend className="visually-hidden">Show</legend>
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              className="filter-chip"
              aria-pressed={f.id === activeFilter.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label} ({rows.filter(({ row, prediction }) => f.matches(row, prediction)).length})
            </button>
          ))}
        </fieldset>
      )}

      {inDialog ? (
        <PreviewItemList
          items={groupByItem(shownRows)}
          sourceData={sourceData}
          languageName={languageName}
          namesById={namesById}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Language</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map(({ row, prediction }, index) => (
                <tr
                  key={`${row.id}-${row.languageCodename}`}
                  className={shownRows[index - 1]?.row.id === row.id ? "same-item" : undefined}
                >
                  {/* An item's variants are next to each other; its name and type span them. */}
                  {shownRows[index - 1]?.row.id !== row.id && (
                    <>
                      <td rowSpan={variantCount(row.id)}>
                        {row.item.name}
                        <Codename codename={row.item.codename} />
                        {row.depth > 0 && (
                          <div className="muted linked-from">
                            Linked from {namesById.get(row.linkedFrom ?? "") ?? "?"}
                          </div>
                        )}
                      </td>
                      <td rowSpan={variantCount(row.id)} className="nowrap-cell">
                        {sourceData.typesById.get(row.item.typeId)?.name ?? row.typeCodename}
                        <Codename codename={row.typeCodename} />
                      </td>
                    </>
                  )}
                  <td className="nowrap-cell">
                    {languageName(row.languageCodename)}
                    <Codename codename={row.languageCodename} />
                  </td>
                  <td>
                    <div className="badges">
                      <span className={`badge ${row.targetStatus === "overwrites existing" ? "badge-warn" : ""}`}>
                        {targetStatusLabel[row.targetStatus]}
                      </span>
                      {prediction.effects.map((effect) => (
                        <span key={effect} className={`badge ${effectBadgeClass[effect]}`}>
                          {effectLabel[effect]}
                        </span>
                      ))}
                    </div>
                    {!saidByBadge(prediction) && prediction.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`${id}-confirm-title`}>
        <h3 id={`${id}-confirm-title`}>
          Copy {plural(plan.rows.length, "variant")} to {target.environmentName}?
        </h3>
        {consequences.length > 0 && (
          <>
            <p>In {target.environmentName}:</p>
            <ul>
              {consequences.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <p>This can&apos;t be undone in Item Copier.</p>
          </>
        )}
        {changed && <p>The copy uses the items in this preview, not the current selection in Kontent.ai.</p>}
        {inDialog && <p>Keep Item Copier open until the copy finishes. Closing it stops the copy.</p>}
        <div className="dialog-actions">
          {/* First in the dialog, so opening it focuses Cancel: the safe choice is the default. */}
          <button type="button" className="btn back-btn" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn continue-btn"
            onClick={() => {
              dialog.current?.close();
              onConfirm(plan);
            }}
          >
            Copy
          </button>
        </div>
      </dialog>

      <div className="actions">
        <button type="button" className="btn back-btn" onClick={onBack}>
          Back
        </button>
        {blockedBy && <span className="muted actions-hint">{blockedBy}</span>}
        <button type="button" className="btn continue-btn" disabled={!!blockedBy} onClick={startCopy}>
          Copy {plural(plan.rows.length, "variant")}
        </button>
      </div>
    </section>
  );
};

const publishOptions: readonly { readonly mode: PublishMode; readonly title: string; readonly description: string }[] =
  [
    {
      mode: "match",
      title: "Match the source",
      description: "Publishing states and schedules in the target end up as in the source.",
    },
    {
      mode: "drafts",
      title: "Copy as drafts",
      description: "Nothing is published or unpublished. Published items stay published, with the copy as a new draft.",
    },
  ];

const targetStatusLabel: Record<TargetStatus, string> = {
  "new item": "New item",
  "new language variant": "New language",
  "overwrites existing": "Overwrites",
};

type RowFilter = {
  readonly id: string;
  readonly label: string;
  readonly matches: (row: PlanRow, prediction: Prediction) => boolean;
};

// Shown when more than one applies, so the rows that change the target are easy to find.
const rowFilters: readonly [RowFilter, ...RowFilter[]] = [
  { id: "all", label: "All", matches: () => true },
  { id: "overwrites", label: "Overwrites", matches: (row) => row.targetStatus === "overwrites existing" },
  {
    id: "live",
    label: "Published",
    matches: (_, p) => p.effects.includes("goes live") || p.effects.includes("replaces live content"),
  },
  { id: "unpublished", label: "Unpublished", matches: (_, p) => p.effects.includes("unpublished") },
];

// Above this many variants, the preview says the copy will take a while.
const largeCopy = 300;

// A plain "Published" outcome only repeats the "Published" or "Replaces published version" badge.
const saidByBadge = (prediction: Prediction) =>
  prediction.outcome === "Published" &&
  (prediction.effects.includes("goes live") || prediction.effects.includes("replaces live content"));

const effectLabel: Record<LiveEffect, string> = {
  "goes live": "Published",
  "replaces live content": "Replaces published version",
  unpublished: "Unpublished",
  "schedule replaced": "Schedule replaced",
  "schedule cancelled": "Schedule cancelled",
};

const effectBadgeClass: Record<LiveEffect, string> = {
  "goes live": "",
  "replaces live content": "badge-warn",
  unpublished: "badge-danger",
  "schedule replaced": "badge-warn",
  "schedule cancelled": "badge-warn",
};

const listLanguages = (languages: readonly string[], limit = 6) =>
  languages.length > limit
    ? `${languages.slice(0, limit).join(", ")} and ${languages.length - limit} more`
    : languages.join(", ");

const resultLabel: Record<Result, string> = { ...targetStatusLabel, ...effectLabel };

const resultBadgeClass = (result: Result) =>
  result === "overwrites existing"
    ? "badge-warn"
    : result in effectBadgeClass
      ? effectBadgeClass[result as LiveEffect]
      : "";

type PreviewItemListProps = {
  readonly items: readonly ItemResults[];
  readonly sourceData: SourceData;
  readonly languageName: (codename: string) => string;
  readonly namesById: ReadonlyMap<string, string>;
};

/**
 * The preview in a dialog, where a table doesn't fit: one row per item with its riskiest result, and the
 * languages, type and codenames in an expandable part.
 */
const PreviewItemList = ({ items, ...rest }: PreviewItemListProps) => (
  <ul className="preview-items" aria-label="Items to copy">
    {items.map((item) => (
      <PreviewItem key={item.id} item={item} {...rest} />
    ))}
  </ul>
);

/**
 * One item. Not a <details>: its summary can't hold another control, and the item's codename icon sits next to
 * its name, as in the table. The name is the toggle, stretched over the whole row, with the icon above it.
 */
const PreviewItem = ({
  item: { variants, main, otherResults },
  sourceData,
  languageName,
  namesById,
}: Omit<PreviewItemListProps, "items"> & { readonly item: ItemResults }) => {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { row: first } = variants[0] as (typeof variants)[number];
  const languages = variants.map((v) => languageName(v.row.languageCodename));

  return (
    <li className={open ? "open" : undefined}>
      <div className="preview-item-header">
        <span className="preview-item-name">
          <span>
            {/* Not a <button>: browsers lay buttons out as a block, so a long name couldn't wrap like text with the
                codename icon after its last word. It behaves as a button for the keyboard and screen readers. */}
            {/* biome-ignore lint/a11y/useSemanticElements: see above */}
            <span
              role="button"
              tabIndex={0}
              className="preview-item-toggle item-name"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen(!open)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setOpen(!open);
              }}
            >
              {first.item.name}
            </span>
            <Codename codename={first.item.codename} />
          </span>
          {/* Under the name rather than beside it, so long names get the full width. */}
          <span className="preview-item-result">
            <span className={`badge ${resultBadgeClass(main)}`}>{resultLabel[main]}</span>
            {otherResults > 0 && (
              <span className="muted" title={`${plural(otherResults, "other result")} in other languages`}>
                +{otherResults}
              </span>
            )}
          </span>
          {/* The type matters most for linked items, which aren't in the selection in Kontent.ai. */}
          <span className="preview-item-meta">
            <span className="muted">Content type:</span>{" "}
            {sourceData.typesById.get(first.item.typeId)?.name ?? first.typeCodename}
          </span>
          <span className="preview-item-meta">
            <span className="muted">{languages.length === 1 ? "Language:" : "Languages:"}</span>{" "}
            {listLanguages(languages, 3)}
          </span>
          {first.depth > 0 && (
            <span className="muted linked-from">Linked from {namesById.get(first.linkedFrom ?? "") ?? "?"}</span>
          )}
        </span>
      </div>
      {open && (
        <div id={detailsId} className="preview-item-details">
          <ul aria-label="Language variants">
            {variants.map(({ row, prediction }) => (
              <li key={row.languageCodename}>
                <span className="preview-item-language">
                  {languageName(row.languageCodename)}
                  <Codename codename={row.languageCodename} />
                </span>
                <span>
                  <span className="badges">
                    <span className={`badge ${resultBadgeClass(row.targetStatus)}`}>
                      {targetStatusLabel[row.targetStatus]}
                    </span>
                    {prediction.effects.map((effect) => (
                      <span key={effect} className={`badge ${effectBadgeClass[effect]}`}>
                        {effectLabel[effect]}
                      </span>
                    ))}
                  </span>
                  {!saidByBadge(prediction) && prediction.outcome}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
};
