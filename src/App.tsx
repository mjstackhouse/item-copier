import { useEffect, useRef, useState } from "react";

import { ConnectStep } from "./components/ConnectStep";
import { CopyStep } from "./components/CopyStep";
import { PreviewStep } from "./components/PreviewStep";
import { Message } from "./components/ui";
import { emptySearch, type SearchState, SelectStep } from "./components/SelectStep";
import {
  type CustomAppSettings,
  insideKontentAi,
  type KontentSelection,
  loadCustomAppSettings,
  watchKontentSelection,
} from "./lib/customApp";
import { type Connection, loadSourceData, type SourceData } from "./lib/kontent";
import type { Plan } from "./lib/plan";
import type { PublishMode } from "./lib/publishing";
import { emptySelection, type Selection } from "./lib/selection";
import { errorMessage } from "./lib/util";

type Step = "connect" | "select" | "preview" | "copy";

const steps: readonly { readonly id: Step; readonly label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "select", label: "Choose items" },
  { id: "preview", label: "Preview" },
  { id: "copy", label: "Copy" },
];

export const App = () => {
  const [step, setStep] = useState<Step>("connect");
  const [source, setSource] = useState<Connection>();
  const [target, setTarget] = useState<Connection>();
  const [sourceData, setSourceData] = useState<SourceData>();
  const [sourceDataError, setSourceDataError] = useState<string>();
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [plan, setPlan] = useState<Plan>();
  const [publishMode, setPublishMode] = useState<PublishMode>("match");
  // Inside Kontent.ai, the Connect step waits for the custom app settings so it can fill in environment IDs.
  const [customApp, setCustomApp] = useState<CustomAppSettings>();
  const [customAppLoading, setCustomAppLoading] = useState(insideKontentAi);
  // In a dialog, what is selected in Kontent.ai takes the place of the search.
  const [kontentSelection, setKontentSelection] = useState<KontentSelection>();
  const dialog = customApp?.dialog ?? false;

  useEffect(() => {
    if (!insideKontentAi()) return;
    loadCustomAppSettings().then((settings) => {
      setCustomApp(settings);
      setCustomAppLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;
    return watchKontentSelection(setKontentSelection);
  }, [dialog]);

  // Load languages and types whenever the source changes. Items are searched for on demand.
  useEffect(() => {
    setSourceData(undefined);
    setSourceDataError(undefined);
    setSelection(emptySelection);
    setSearch(emptySearch);
    if (!source) return;

    let cancelled = false;
    loadSourceData(source.client)
      .then((data) => {
        if (cancelled) return;
        setSourceData(data);
        const defaultLanguage = data.languages.find((l) => l.isDefault) ?? data.languages[0];
        setSelection({ ...emptySelection, languageCodename: defaultLanguage?.codename ?? "" });
      })
      .catch((e: unknown) => {
        console.error(e);
        if (!cancelled) setSourceDataError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // On every step change but the first page load: back to the top, and focus on the new step's heading, so keyboard
  // and screen reader users start there instead of on a button that no longer exists.
  // Choose items first shows a loading screen, whose heading is replaced once the source data has loaded.
  const focusKey = step === "select" ? `select-${sourceData ? "ready" : "loading"}` : step;
  const firstStep = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the trigger, not a value the effect reads
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const heading = document.querySelector<HTMLElement>("main > section h2");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
  }, [focusKey]);

  const currentIndex = steps.findIndex((s) => s.id === step);

  return (
    <main className={dialog ? "dialog-mode" : undefined}>
      <p id="app-title">Item Copier</p>
      <header>
        {/* Not until the custom app settings have loaded: until then, it isn't known whether this is a dialog,
            and the wording about where the keys are kept depends on it. */}
        {step === "connect" && !customAppLoading && (
          <p className="intro">
            Copy content items, the items they link to and the assets they use from one Kontent.ai environment to
            another.{" "}
            {dialog
              ? "Your API keys stay in this dialog and are cleared when you close it."
              : "Your API keys stay in this browser tab and are never stored."}
          </p>
        )}
        <ol className="stepper">
          {steps.map((s, index) => (
            <li
              key={s.id}
              className={index === currentIndex ? "current" : index < currentIndex ? "done" : ""}
              aria-current={index === currentIndex ? "step" : undefined}
            >
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      {step === "connect" &&
        (customAppLoading ? (
          <section>
            <h2>Connect environments</h2>
            <p className="loading-general" role="status">
              Loading environment info from Kontent.ai
            </p>
          </section>
        ) : (
          <ConnectStep
            source={source}
            target={target}
            customApp={customApp}
            onSourceChange={setSource}
            onTargetChange={setTarget}
            onNext={() => setStep("select")}
          />
        ))}

      {step === "select" &&
        (source && sourceData ? (
          <SelectStep
            source={source}
            sourceData={sourceData}
            selection={selection}
            search={search}
            kontentSelection={dialog ? (kontentSelection ?? { page: "other", itemIds: [] }) : undefined}
            onChange={setSelection}
            onSearchChange={setSearch}
            onBack={() => setStep("connect")}
            onNext={() => setStep("preview")}
          />
        ) : (
          <section>
            <h2>Choose items</h2>
            {sourceDataError ? (
              <Message kind="error">Could not load the source environment: {sourceDataError}</Message>
            ) : (
              <p className="loading-general" role="status">
                Loading languages and content types from the source environment
              </p>
            )}
            <div className="actions">
              <button type="button" className="btn back-btn" onClick={() => setStep("connect")}>
                Back
              </button>
            </div>
          </section>
        ))}

      {step === "preview" && source && target && sourceData && (
        <PreviewStep
          source={source}
          target={target}
          sourceData={sourceData}
          selection={selection}
          publishMode={publishMode}
          inDialog={dialog}
          kontentSelection={dialog ? kontentSelection : undefined}
          onPickedItemsChange={(items, fromKey) =>
            setSelection((s) => ({ ...s, pickedItems: [...items], pickedFromKey: fromKey }))
          }
          onPublishModeChange={setPublishMode}
          onSkipMissingReferencesChange={(skip) => setSelection((s) => ({ ...s, skipMissingReferences: skip }))}
          onBack={() => setStep("select")}
          onConfirm={(p) => {
            setPlan(p);
            setStep("copy");
          }}
        />
      )}

      {step === "copy" && source && target && sourceData && plan && (
        <CopyStep
          source={source}
          target={target}
          selection={selection}
          plan={plan}
          publishMode={publishMode}
          sourceWorkflowSteps={sourceData.workflowSteps}
          languages={sourceData.languages}
          inDialog={dialog}
          onStartOver={() => {
            setPlan(undefined);
            setSelection({ ...selection, pickedItems: [], pickedFromKey: undefined });
            setStep("select");
          }}
        />
      )}

      {/* Background rather than a warning, so it stays out of the way; the preview's confirmation carries the
          warning that copies can't be undone in Item Copier. */}
      <footer className="app-footer">
        {/* One inline run: as separate flex items, the space before the link would be dropped. */}
        <span>
          Not an official Kontent.ai tool ·{" "}
          <a
            href={`https://github.com/mjstackhouse/item-copier#${dialog ? "dialog-mode" : "how-to-use-it"}`}
            target="_blank"
            rel="noreferrer"
          >
            How to use it
          </a>
        </span>
      </footer>
    </main>
  );
};
