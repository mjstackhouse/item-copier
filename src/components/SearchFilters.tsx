import { useId } from "react";
import Select, { type GroupBase } from "react-select";

import type { SearchFilters as Filters, SourceData } from "../lib/kontent";
import type { StepKind } from "../lib/publishing";
import { type Option, selectStyles } from "./selectStyles";

type Props = {
  readonly sourceData: SourceData;
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
};

type Options = readonly (Option | GroupBase<Option>)[];

// The order the Kontent.ai app lists a workflow's steps in.
const stepOrder: Record<StepKind, number> = { draft: 0, scheduled: 1, published: 2, archived: 3 };

/** Content type, collection, workflow step and taxonomy filters, each a searchable multi-select. */
export const SearchFilters = ({ sourceData, filters, onChange }: Props) => {
  const id = useId();

  const typeOptions: Option[] = [...sourceData.typesById.values()]
    .map((t) => ({ value: t.id, label: t.name }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const collectionOptions: Option[] = sourceData.collections.map((c) => ({ value: c.id, label: c.name }));

  // Grouped by workflow, like in the app, because each workflow has its own steps.
  const workflows = new Map<string, { name: string; steps: { option: Option; order: number }[] }>();
  for (const [key, step] of sourceData.workflowSteps) {
    const workflow = workflows.get(step.workflowId) ?? { name: step.workflowName, steps: [] };
    workflow.steps.push({
      option: { value: key, label: step.name, chipLabel: `${step.workflowName}: ${step.name}` },
      order: stepOrder[step.kind],
    });
    workflows.set(step.workflowId, workflow);
  }
  const stepGroups = [...workflows.values()].map((w) => ({
    label: w.name,
    // A stable sort keeps the workflow's own order among its draft steps.
    options: [...w.steps].sort((a, b) => a.order - b.order).map((s) => s.option),
  }));
  // With one workflow, its name adds nothing.
  const stepOptions: Options =
    stepGroups.length === 1
      ? (stepGroups[0]?.options ?? []).map((o) => ({ ...o, chipLabel: undefined }))
      : stepGroups;

  // Grouped by taxonomy group, with nested terms indented, like in the app.
  const termOptions: Options = sourceData.taxonomyGroups.map((group) => ({
    label: group.name,
    options: [
      // Items whose content type uses the group but that have none of its terms; marked like in the app.
      { value: `${group.id}/`, label: `⌀ Not in ${group.name}` },
      ...group.terms.map((term) => ({
        value: `${group.id}/${term.id}`,
        label: term.name,
        depth: term.depth,
        chipLabel: `${group.name}: ${term.name}`,
      })),
    ],
  }));

  const field = (params: {
    readonly key: keyof Filters;
    readonly label: string;
    readonly options: Options;
    readonly placeholder: string;
  }) => {
    const all = params.options.flatMap((o) => ("options" in o ? o.options : [o]));
    const chosen = filters[params.key];
    return (
      <div className="filter-field">
        <label className="field-label" htmlFor={`${id}-${params.key}`}>
          {params.label}
        </label>
        <Select<Option, true>
          inputId={`${id}-${params.key}`}
          isMulti
          options={params.options}
          // In the order they were chosen.
          value={chosen.flatMap((v) => all.filter((o) => o.value === v))}
          onChange={(selected) => onChange({ ...filters, [params.key]: selected.map((o) => o.value) })}
          formatOptionLabel={(option, { context }) => (context === "value" ? (option.chipLabel ?? option.label) : option.label)}
          // Search by the group too, so "Product category" finds all of its terms.
          filterOption={(option, input) =>
            (option.data.chipLabel ?? option.label).toLowerCase().includes(input.toLowerCase())
          }
          placeholder={params.placeholder}
          noOptionsMessage={() => "Nothing matches"}
          closeMenuOnSelect={false}
          classNamePrefix="select"
          styles={selectStyles<Option>()}
        />
      </div>
    );
  };

  return (
    <div className="search-filters">
      {field({ key: "contentTypeIds", label: "Content type", options: typeOptions, placeholder: "Any content type" })}
      {collectionOptions.length > 1 &&
        field({ key: "collectionIds", label: "Collection", options: collectionOptions, placeholder: "Any collection" })}
      {field({ key: "workflowSteps", label: "Workflow step", options: stepOptions, placeholder: "Any workflow step" })}
      {termOptions.length > 0 &&
        field({ key: "taxonomyTerms", label: "Taxonomy", options: termOptions, placeholder: "Any taxonomy term" })}
    </div>
  );
};
