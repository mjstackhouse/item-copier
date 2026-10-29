import type { ReactNode } from "react";

type MessageKind = "error" | "warning" | "ok";

const icons: Record<MessageKind, string> = { error: "⚠", warning: "⚠", ok: "✓" };

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
  <div className={`message message-${kind}${multiline ? " multiline" : ""}`} role={kind === "error" ? "alert" : undefined}>
    <span className="message-icon" aria-hidden="true">
      {icons[kind]}
    </span>
    <div className="message-text">{children}</div>
  </div>
);

/** An ⓘ icon next to a label that explains it on hover. */
export const Tooltip = ({ text }: { readonly text: string }) => (
  <span className="tooltip-icon" title={text} aria-label={text} role="img">
    ⓘ
  </span>
);
