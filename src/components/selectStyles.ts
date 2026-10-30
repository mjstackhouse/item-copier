import type { GroupBase, StylesConfig } from "react-select";

export type Option = {
  readonly value: string;
  readonly label: string;
  /** Indents the option in the menu, for nested taxonomy terms. */
  readonly depth?: number;
  /** Shown on the chip once chosen, when the label alone is ambiguous (for example "Workflow: Step"). */
  readonly chipLabel?: string;
};

// Matches how the author's usage insights and asset description auditor style react-select:
// a light gray box without a border, and white pill-shaped chips with a gray border.
export const selectStyles = <T extends Option>(): StylesConfig<T, true, GroupBase<T>> => ({
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
  // Long labels such as "Product category: Hand held" wrap instead of being cut off.
  multiValueLabel: (base) => ({
    ...base,
    padding: "3px 0",
    fontSize: "13px",
    whiteSpace: "normal",
    color: "var(--lighter-black)",
  }),
  multiValueRemove: (base) => ({
    ...base,
    marginLeft: "2px",
    borderRadius: "9999px",
    color: "var(--color-gray-400)",
    cursor: "pointer",
    "&:hover": { backgroundColor: "transparent", color: "var(--red)" },
  }),
  menu: (base) => ({ ...base, zIndex: 30, borderRadius: "8px" }),
  groupHeading: (base) => ({
    ...base,
    fontSize: "13px",
    fontWeight: 700,
    textTransform: "none",
    color: "var(--lighter-black)",
  }),
  option: (base, state) => ({
    ...base,
    fontSize: "14px",
    paddingLeft: `${12 + (state.data.depth ?? 0) * 16}px`,
    color: "var(--lighter-black)",
    backgroundColor: state.isFocused ? "var(--lighter-purple)" : "white",
    cursor: "pointer",
  }),
});
