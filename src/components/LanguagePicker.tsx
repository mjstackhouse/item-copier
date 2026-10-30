import { useId } from "react";
import Select from "react-select";

import type { Language } from "../lib/kontent";
import { type Option, selectStyles } from "./selectStyles";
import { Tooltip } from "./ui";

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
          styles={selectStyles<Option>()}
        />
      )}
    </fieldset>
  );
};
