import { useMemo, useState } from "react";

import { type Connection, errorMessage, type Item, type SearchResult, searchItems, type SourceData } from "../lib/kontent";

export type Selection = {
  readonly languageCodename: string;
  readonly pickedItems: readonly Item[];
  readonly linkedItemsDepth: number;
  readonly skipMissingReferences: boolean;
};

/** The last search and its loaded results; kept by the parent so it survives going back from the preview. */
export type SearchState = {
  readonly phrase: string;
  readonly results?: SearchResult;
};

export const emptySearch: SearchState = { phrase: "" };

type Props = {
  readonly source: Connection;
  readonly sourceData: SourceData;
  readonly selection: Selection;
  readonly search: SearchState;
  readonly onChange: (selection: Selection) => void;
  readonly onSearchChange: (search: SearchState) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
};

export const SelectStep = ({
  source,
  sourceData,
  selection,
  search,
  onChange,
  onSearchChange,
  onBack,
  onNext,
}: Props) => {
  const [phrase, setPhrase] = useState(search.phrase);
  const [status, setStatus] = useState<{ readonly loading?: "search" | "more"; readonly error?: string }>({});
  const picked = useMemo(() => new Set(selection.pickedItems.map((i) => i.id)), [selection.pickedItems]);

  const runSearch = async (continuationToken?: string | null) => {
    setStatus({ loading: continuationToken ? "more" : "search" });
    try {
      const page = await searchItems({
        client: source.client,
        searchPhrase: continuationToken ? search.phrase : phrase,
        languageCodename: selection.languageCodename,
        continuationToken,
      });
      onSearchChange(
        continuationToken && search.results
          ? {
              phrase: search.phrase,
              results: { items: [...search.results.items, ...page.items], continuationToken: page.continuationToken },
            }
          : { phrase, results: page },
      );
      setStatus({});
    } catch (error) {
      console.error(error);
      setStatus({ error: `Could not search: ${errorMessage(error)}` });
    }
  };

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    void runSearch();
  };

  const toggle = (item: Item) =>
    onChange({
      ...selection,
      pickedItems: picked.has(item.id)
        ? selection.pickedItems.filter((p) => p.id !== item.id)
        : [...selection.pickedItems, item],
    });

  const changeLanguage = (languageCodename: string) => {
    onChange({ ...selection, languageCodename });
    // Results are for one language, so they no longer apply.
    onSearchChange({ phrase: search.phrase });
  };

  const typeName = (typeId: string) => sourceData.typesById.get(typeId)?.name ?? "";
  const results = search.results;

  return (
    <section>
      <h2>Choose items</h2>

      <div className="options">
        <label>
          Language
          <select value={selection.languageCodename} onChange={(e) => changeLanguage(e.target.value)}>
            {sourceData.languages.map((l) => (
              <option key={l.id} value={l.codename}>
                {l.name} ({l.codename})
              </option>
            ))}
          </select>
        </label>
        <label>
          Include linked items
          <select
            value={selection.linkedItemsDepth}
            onChange={(e) => onChange({ ...selection, linkedItemsDepth: Number(e.target.value) })}
          >
            <option value={0}>No, only the items I pick</option>
            <option value={1}>Yes, 1 level deep</option>
            <option value={2}>Yes, 2 levels deep</option>
            <option value={3}>Yes, 3 levels deep</option>
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={selection.skipMissingReferences}
            onChange={(e) => onChange({ ...selection, skipMissingReferences: e.target.checked })}
          />
          Skip references to deleted items
        </label>
      </div>

      <p className="hint">
        Without linked items, the copied items still point to the items they link to. Those links work once the linked
        items exist in the target too.
      </p>

      <form className="search-form" onSubmit={handleSearch}>
        <input
          type="search"
          aria-label="Search items"
          placeholder="Search by item name or text content"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
        />
        <button type="submit" disabled={!!status.loading}>
          {status.loading === "search" ? "Searching…" : "Search"}
        </button>
      </form>
      <p className="hint">Leave the search empty to list all items in this language.</p>
      {status.error && <p className="message error">{status.error}</p>}

      {results && (
        <ul className="item-list" aria-label="Search results">
          {results.items.map((item) => (
            <li key={item.id}>
              <label className="checkbox">
                <input type="checkbox" checked={picked.has(item.id)} onChange={() => toggle(item)} />
                <span className="item-name">{item.name}</span>
                <span className="muted">{typeName(item.typeId)}</span>
              </label>
            </li>
          ))}
          {results.items.length === 0 && <li className="muted">No items match.</li>}
          {results.continuationToken && (
            <li>
              <button type="button" disabled={!!status.loading} onClick={() => void runSearch(results.continuationToken)}>
                {status.loading === "more" ? "Loading…" : "Load more"}
              </button>
            </li>
          )}
        </ul>
      )}

      {selection.pickedItems.length > 0 && (
        <>
          <h3>Selected items</h3>
          <ul className="item-list" aria-label="Selected items">
            {selection.pickedItems.map((item) => (
              <li key={item.id} className="selected-item">
                <span>
                  <span className="item-name">{item.name}</span>{" "}
                  <span className="muted">{typeName(item.typeId)}</span>
                </span>
                <button type="button" onClick={() => toggle(item)} aria-label={`Remove ${item.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="actions">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <span className="muted">{selection.pickedItems.length} selected</span>
        <button type="button" className="primary" disabled={selection.pickedItems.length === 0} onClick={onNext}>
          Next: preview
        </button>
      </div>
    </section>
  );
};
