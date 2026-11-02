import { useId, useMemo, useState } from "react";

import {
  activeFilterCount,
  type Connection,
  type SearchFilters as Filters,
  type Item,
  noFilters,
  type SearchResult,
  type SourceData,
  searchItems,
} from "../lib/kontent";
import { languagesToCopy, type Selection } from "../lib/selection";
import { errorMessage } from "../lib/util";
import { LanguagePicker } from "./LanguagePicker";
import { SearchFilters } from "./SearchFilters";
import { Message, Tooltip } from "./ui";

/** The last search and its loaded results; kept by the parent so it survives going back from the preview. */
export type SearchState = {
  readonly phrase: string;
  readonly filters: Filters;
  readonly results?: SearchResult;
};

export const emptySearch: SearchState = { phrase: "", filters: noFilters };

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
  const [filters, setFilters] = useState(search.filters);
  const filterCount = activeFilterCount(filters);
  const [filtersOpen, setFiltersOpen] = useState(filterCount > 0);
  const [status, setStatus] = useState<{ readonly loading?: "search" | "more"; readonly error?: string }>({});
  const picked = useMemo(() => new Set(selection.pickedItems.map((i) => i.id)), [selection.pickedItems]);

  const runSearch = async (continuationToken?: string | null) => {
    setStatus({ loading: continuationToken ? "more" : "search" });
    try {
      const page = await searchItems({
        client: source.client,
        searchPhrase: continuationToken ? search.phrase : phrase,
        filters: continuationToken ? search.filters : filters,
        languageCodename: selection.languageCodename,
        continuationToken,
      });
      onSearchChange(
        continuationToken && search.results
          ? {
              phrase: search.phrase,
              filters: search.filters,
              results: { items: [...search.results.items, ...page.items], continuationToken: page.continuationToken },
            }
          : { phrase, filters, results: page },
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
    onSearchChange({ phrase: search.phrase, filters: search.filters });
  };

  const noLanguages = languagesToCopy(selection, sourceData.languages).length === 0;
  const id = useId();
  // Collapsed by default: most copies use the defaults, and the summary shows what they are.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsSummary = describeSettings(selection, sourceData);

  const typeName = (typeId: string) => sourceData.typesById.get(typeId)?.name ?? "";
  const results = search.results;

  return (
    <section>
      <h2>Choose items</h2>

      <div className="card step-card">
        <h3>Find items</h3>

        <div>
          <form className="search-form" onSubmit={handleSearch}>
            {/* Only affects searching: each item is copied in the languages chosen in Copy settings. */}
            {sourceData.languages.length > 1 && (
              <select
                className="search-language"
                aria-label="Search in language"
                title="Search in language"
                value={selection.languageCodename}
                onChange={(e) => changeLanguage(e.target.value)}
              >
                {sourceData.languages.map((l) => (
                  <option key={l.id} value={l.codename}>
                    {l.name} ({l.codename})
                  </option>
                ))}
              </select>
            )}
            <input
              type="search"
              aria-label="Search items"
              placeholder="Search by item name or text content"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <button
              type="button"
              className="btn back-btn filters-toggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              {filterCount > 0 ? `Filters (${filterCount})` : "Filters"}
            </button>
            <button type="submit" className="btn continue-btn" disabled={!!status.loading}>
              {status.loading === "search" && <span className="loading-span" aria-hidden="true" />}
              {status.loading === "search" ? "Searching" : "Search"}
            </button>
          </form>
          {filtersOpen && (
            <div className="filters-panel">
              <SearchFilters sourceData={sourceData} filters={filters} onChange={setFilters} />
              {filterCount > 0 && (
                <button type="button" className="link-btn" onClick={() => setFilters(noFilters)}>
                  Clear filters
                </button>
              )}
            </div>
          )}
          <p className="hint">
            Searches in the selected language. Leave the search empty to list all items that match the filters.
          </p>
        </div>
        {status.error && <Message kind="error">{status.error}</Message>}

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
              <li className="load-more">
                <button
                  type="button"
                  className="btn back-btn"
                  disabled={!!status.loading}
                  onClick={() => void runSearch(results.continuationToken)}
                >
                  {status.loading === "more" ? "Loading…" : "Load more"}
                </button>
              </li>
            )}
          </ul>
        )}

        {selection.pickedItems.length > 0 && (
          <div>
            <h3 className="list-heading">Selected items</h3>
            <ul className="item-list" aria-label="Selected items">
              {selection.pickedItems.map((item) => (
                <li key={item.id} className="selected-item">
                  <span>
                    <span className="item-name">{item.name}</span>{" "}
                    <span className="muted">{typeName(item.typeId)}</span>
                  </span>
                  <button
                    type="button"
                    className="delete-btn"
                    onClick={() => toggle(item)}
                    aria-label={`Remove ${item.name}`}
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <details
        className="card settings-card"
        open={settingsOpen}
        onToggle={(e) => setSettingsOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          <span className="section-heading">Copy settings</span>
          {!settingsOpen && <span className="muted settings-summary">{settingsSummary}</span>}
        </summary>
        <div className="settings-body">
          {sourceData.languages.length > 1 && (
            <LanguagePicker
              languages={sourceData.languages}
              copyAll={selection.copyAllLanguages}
              chosen={selection.chosenLanguages}
              onChange={({ copyAll, chosen }) =>
                onChange({ ...selection, copyAllLanguages: copyAll, chosenLanguages: chosen })
              }
            />
          )}

          <div className="field">
            <div className="field-label">
              <label htmlFor={`${id}-depth`}>Include linked items</label>
              <Tooltip text="Without linked items, the copied items still point to the items they link to. Those links work once the linked items exist in the target too." />
            </div>
            <select
              id={`${id}-depth`}
              className="depth-select"
              value={selection.linkedItemsDepth}
              onChange={(e) => onChange({ ...selection, linkedItemsDepth: Number(e.target.value) })}
            >
              <option value={0}>No, only the items I pick</option>
              <option value={1}>Yes, 1 level deep</option>
              <option value={2}>Yes, 2 levels deep</option>
              <option value={3}>Yes, 3 levels deep</option>
              <option value={allLevels}>Yes, all linked items</option>
            </select>
          </div>

          <div className="field">
            <div className="field-label">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selection.skipMissingReferences}
                  onChange={(e) => onChange({ ...selection, skipMissingReferences: e.target.checked })}
                />
                Skip missing references
              </label>
              <Tooltip text="References to items or assets that were deleted in the source are left out of the copied content. Without this, the copy stops at the first one. The preview tells you if there are any." />
            </div>
          </div>
        </div>
      </details>
      {noLanguages && <Message kind="warning">Choose at least one language to copy.</Message>}
      <div className="actions">
        <button type="button" className="btn back-btn" onClick={onBack}>
          Back
        </button>
        <span className="muted actions-hint">{selection.pickedItems.length} selected</span>
        <button
          type="button"
          className="btn continue-btn"
          disabled={selection.pickedItems.length === 0 || noLanguages}
          onClick={onNext}
        >
          Preview
        </button>
      </div>
    </section>
  );
};

// Follows links until there are none left. A select option's value is a string, and Number("Infinity") is Infinity.
const allLevels = Number.POSITIVE_INFINITY;

/** One line describing the copy settings, shown while they are collapsed. */
const describeSettings = (selection: Selection, sourceData: SourceData): string => {
  const parts: string[] = [];
  const { languages } = sourceData;
  if (languages.length > 1) {
    const chosen = languagesToCopy(selection, languages);
    parts.push(
      selection.copyAllLanguages
        ? `All ${languages.length} languages`
        : chosen.length === 0
          ? "No languages chosen"
          : chosen.length <= 3
            ? chosen.map((c) => languages.find((l) => l.codename === c)?.name ?? c).join(", ")
            : `${chosen.length} languages`,
    );
  }
  const depth = selection.linkedItemsDepth;
  parts.push(
    depth === 0
      ? "No linked items"
      : depth === allLevels
        ? "All linked items"
        : `Linked items ${depth} level${depth === 1 ? "" : "s"} deep`,
  );
  if (selection.skipMissingReferences) parts.push("Skip missing references");
  return parts.join(" · ");
};
