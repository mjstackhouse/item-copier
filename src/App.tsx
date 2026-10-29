import { useEffect, useState } from "react";

import { ConnectStep } from "./components/ConnectStep";
import { CopyStep } from "./components/CopyStep";
import { PreviewStep } from "./components/PreviewStep";
import { emptySearch, type SearchState, type Selection, SelectStep } from "./components/SelectStep";
import { type Connection, errorMessage, loadSourceData, type SourceData } from "./lib/kontent";
import type { Plan } from "./lib/plan";

type Step = "connect" | "select" | "preview" | "copy";

const steps: readonly { readonly id: Step; readonly label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "select", label: "Choose items" },
  { id: "preview", label: "Preview" },
  { id: "copy", label: "Copy" },
];

const emptySelection: Selection = { languageCodename: "", pickedItems: [], linkedItemsDepth: 1, skipMissingReferences: false };

export const App = () => {
  const [step, setStep] = useState<Step>("connect");
  const [source, setSource] = useState<Connection>();
  const [target, setTarget] = useState<Connection>();
  const [sourceData, setSourceData] = useState<SourceData>();
  const [sourceDataError, setSourceDataError] = useState<string>();
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [search, setSearch] = useState<SearchState>(emptySearch);
  const [plan, setPlan] = useState<Plan>();

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

  const currentIndex = steps.findIndex((s) => s.id === step);

  return (
    <main>
      <header>
        <h1>Copy content items between environments</h1>
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

      {step === "connect" && (
        <ConnectStep
          source={source}
          target={target}
          onSourceChange={setSource}
          onTargetChange={setTarget}
          onNext={() => setStep("select")}
        />
      )}

      {step === "select" &&
        (source && sourceData ? (
          <SelectStep
            source={source}
            sourceData={sourceData}
            selection={selection}
            search={search}
            onChange={setSelection}
            onSearchChange={setSearch}
            onBack={() => setStep("connect")}
            onNext={() => setStep("preview")}
          />
        ) : (
          <section>
            <h2>Choose items</h2>
            {sourceDataError ? (
              <p className="message error">Could not load the source environment: {sourceDataError}</p>
            ) : (
              <p className="muted">Loading languages and content types from the source environment…</p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setStep("connect")}>
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
          onBack={() => setStep("select")}
          onConfirm={(p) => {
            setPlan(p);
            setStep("copy");
          }}
        />
      )}

      {step === "copy" && source && target && plan && (
        <CopyStep
          source={source}
          target={target}
          selection={selection}
          plan={plan}
          onStartOver={() => {
            setPlan(undefined);
            setSelection({ ...selection, pickedItems: [] });
            setStep("select");
          }}
        />
      )}
    </main>
  );
};
