import { Component, type ReactNode, useId } from "react";

import { errorMessage } from "../lib/util";

/** "info" is for things worth knowing that are not a problem, so it is styled neutrally. */
type MessageKind = "error" | "warning" | "ok" | "info";

const icons: Record<MessageKind, string> = { error: "⚠", warning: "⚠", ok: "✓", info: "ⓘ" };

/** A message with a colored icon section next to the text, as in the author's other Kontent.ai tools. */
export const Message = ({
  kind,
  multiline,
  children,
}: {
  readonly kind: MessageKind;
  /** Keeps line breaks in the text, for multi-line errors from the toolkit. */
  readonly multiline?: boolean;
  readonly children: ReactNode;
}) => (
  <div
    className={`message message-${kind}${multiline ? " multiline" : ""}`}
    role={kind === "error" ? "alert" : undefined}
  >
    <span className="message-icon" aria-hidden="true">
      {icons[kind]}
    </span>
    <div className="message-text">{children}</div>
  </div>
);

/**
 * An ⓘ button next to a label that shows an explanation on hover, keyboard focus or tap, and hides it with
 * Escape. A `title` attribute alone can't be reached with the keyboard or on touch screens.
 */
export const Tooltip = ({ text }: { readonly text: string }) => {
  const id = useId();
  return (
    <span className="tooltip">
      <button
        type="button"
        className="tooltip-icon"
        aria-label="More information"
        aria-describedby={id}
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
      >
        ⓘ
      </button>
      <span id={id} role="tooltip" className="tooltip-text">
        {text}
      </span>
    </span>
  );
};

/**
 * Shows an unexpected rendering error instead of a blank page. Errors from API calls are handled where they
 * happen; this only catches bugs.
 */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error?: unknown }> {
  state: { readonly error?: unknown } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <main>
        <Message kind="error">
          <p>Something went wrong on this page: {errorMessage(this.state.error)}</p>
          <p>
            A copy that was running keeps going in the background while this tab stays open. Wait a minute before you
            reload the page, then check the target environment.
          </p>
        </Message>
      </main>
    );
  }
}
