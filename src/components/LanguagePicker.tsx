import { useId } from "react";
import Select, { type StylesConfig } from "react-select";

import type { Language } from "../lib/kontent";
import { Tooltip } from "./ui";

type Option = { readonly value: string; readonly label: string };

type Props = {
  readonly languages: readonly Language[];
  readonly copyAll: boolean;
  readonly chosen: readonly string[];
  readonly onChange: (change: { readonly copyAll: boolean; readonly chosen: readonly string[] }) => void;
};

/**
 * "All languages" or a searchable multi-select of chosen ones. The multi-select only appears when it
 * is needed, so environments with many languages don't get a long list of checkboxes.
 */
export const LanguagePicker = ({ languages, copyAll, chosen, onChange }: Props) => {
  const id = useId();
  const options: Option[] = languages.map((l) => ({ value: l.codename, label: `${l.name} (${l.codename})` }));
  // Keeps the source's language order, so the default language comes first.
  const inOrder = (codenames: readonly string[]) =>
    languages.map((l) => l.codename).filter((c) => codenames.includes(c));

  return (
    <fieldset className="copy-languages">
      <legend>
        Languages to copy
        <Tooltip text="Each selected item is copied in every chosen language it has a variant in." />
      </legend>
      <div className="copy-languages-modes">
        <label className="checkbox">
          <input type="radio" name={`${id}-mode`} checked={copyAll} onChange={() => onChange({ copyAll: true, chosen })} />
          All languages ({languages.length})
        </label>
        <label className="checkbox">
          <input
            type="radio"
            name={`${id}-mode`}
            checked={!copyAll}
            onChange={() => onChange({ copyAll: false, chosen })}
          />
          Choose languages
        </label>
      </div>
      {!copyAll && (
        <Select<Option, true>
          inputId={`${id}-select`}
          aria-label="Languages to copy"
          isMulti
          options={options}
          value={options.filter((o) => chosen.includes(o.value))}
          onChange={(selected) => onChange({ copyAll: false, chosen: inOrder(selected.map((o) => o.value)) })}
          placeholder="Search languages…"
          noOptionsMessage={() => "No languages match"}
          closeMenuOnSelect={false}
          // Switching back to "All languages" does what a "clear all" button would.
          isClearable={false}
          classNamePrefix="select"
          styles={selectStyles}
        />
      )}
    </fieldset>
  );
};

// Matches how the author's usage insights and asset description auditor style react-select:
// a light gray box without a border, and white pill-shaped chips with a gray border.
const selectStyles: StylesConfig<Option, true> = {
  control: (base, state) => ({
    ...base,
    fontSize: "13px",
    minHeight: "40px",
    padding: "4px 8px",
    border: `1px solid ${state.isFocused ? "var(--lighter-black)" : "transparent"}`,
    borderRadius: "8px",
    backgroundColor: state.isFocused ? "white" : "var(--color-gray-100)",
    boxShadow: "none",
    "&:hover": { borderColor: "var(--lighter-black)" },
  }),
  valueContainer: (base) => ({ ...base, gap: "4px", padding: 0 }),
  placeholder: (base) => ({ ...base, color: "var(--color-gray-500)" }),
  multiValue: (base) => ({
    ...base,
    alignItems: "center",
    margin: 0,
    padding: "0 2px 0 8px",
    border: "1px solid var(--color-gray-400)",
    borderRadius: "9999px",
    backgroundColor: "white",
  }),
  multiValueLabel: (base) => ({ ...base, padding: "3px 0", fontSize: "13px", color: "var(--lighter-black)" }),
  multiValueRemove: (base) => ({
    ...base,
    marginLeft: "2px",
    borderRadius: "9999px",
    color: "var(--color-gray-400)",
    cursor: "pointer",
    "&:hover": { backgroundColor: "transparent", color: "var(--red)" },
  }),
  menu: (base) => ({ ...base, zIndex: 30, borderRadius: "8px" }),
  option: (base, state) => ({
    ...base,
    fontSize: "14px",
    color: "var(--lighter-black)",
    backgroundColor: state.isFocused ? "var(--lighter-purple)" : "white",
    cursor: "pointer",
  }),
};
