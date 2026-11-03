import { useId, useState } from "react";

import type { CustomAppSettings } from "../lib/customApp";
import { type Connection, connect } from "../lib/kontent";
import { errorMessage } from "../lib/util";
import { Message, Tooltip } from "./ui";

type Props = {
  readonly source?: Connection;
  readonly target?: Connection;
  /** Set when running as a Kontent.ai custom app. */
  readonly customApp?: CustomAppSettings;
  readonly onSourceChange: (connection: Connection | undefined) => void;
  readonly onTargetChange: (connection: Connection | undefined) => void;
  readonly onNext: () => void;
};

export const ConnectStep = ({ source, target, customApp, onSourceChange, onTargetChange, onNext }: Props) => {
  const sameEnvironment = source && target && source.environmentId === target.environmentId;
  // Held here so each side can tell whether the other already uses the environment the app is opened in.
  const [sourceEnvironmentId, setSourceEnvironmentId] = useState(
    source?.environmentId ?? customApp?.sourceEnvironmentId ?? "",
  );
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(
    target?.environmentId ?? customApp?.targetEnvironmentId ?? "",
  );

  return (
    <section>
      <h2>Connect environments</h2>
      <div className="two-columns">
        <EnvironmentForm
          label="Copy from (source)"
          permissions="Read content, Read assets, Manage content model and Manage environment settings"
          connection={source}
          environmentId={sourceEnvironmentId}
          otherEnvironmentId={targetEnvironmentId}
          otherSide="target"
          currentEnvironmentId={customApp?.currentEnvironmentId}
          lockedToCurrent={customApp?.dialog}
          inDialog={customApp?.dialog}
          onEnvironmentIdChange={setSourceEnvironmentId}
          onChange={onSourceChange}
        />
        <EnvironmentForm
          label="Copy to (target)"
          permissions="Create, edit, and delete content; Create, edit, and delete assets; Manage content model; and Manage environment settings"
          connection={target}
          environmentId={targetEnvironmentId}
          otherEnvironmentId={sourceEnvironmentId}
          inDialog={customApp?.dialog}
          otherSide="source"
          currentEnvironmentId={customApp?.currentEnvironmentId}
          onEnvironmentIdChange={setTargetEnvironmentId}
          onChange={onTargetChange}
        />
      </div>
      {sameEnvironment && <Message kind="error">Source and target are the same environment.</Message>}
      <div className="actions">
        <button
          type="button"
          className="btn continue-btn"
          disabled={!source || !target || !!sameEnvironment}
          onClick={onNext}
        >
          Choose items
        </button>
      </div>
    </section>
  );
};

const canMaskText = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");

type FormProps = {
  readonly label: string;
  /** The Management API key permissions this side needs; the app also reads the content model and settings. */
  readonly permissions: string;
  readonly connection?: Connection;
  readonly environmentId: string;
  /** The environment ID entered on the other side. */
  readonly otherEnvironmentId: string;
  readonly otherSide: "source" | "target";
  /** The environment the custom app is opened in, offered with "Use this environment". */
  readonly currentEnvironmentId?: string;
  /** In a dialog, the source is always the environment the app is opened in. */
  readonly lockedToCurrent?: boolean;
  /** In a Kontent.ai dialog, which keeps the key until it's closed, rather than a browser tab. */
  readonly inDialog?: boolean;
  readonly onEnvironmentIdChange: (environmentId: string) => void;
  readonly onChange: (connection: Connection | undefined) => void;
};

const EnvironmentForm = ({
  label,
  permissions,
  connection,
  environmentId,
  otherEnvironmentId,
  otherSide,
  currentEnvironmentId,
  lockedToCurrent,
  inDialog,
  onEnvironmentIdChange,
  onChange,
}: FormProps) => {
  const [apiKey, setApiKey] = useState(connection?.apiKey ?? "");
  const [status, setStatus] = useState<{ readonly loading: boolean; readonly error?: string }>({ loading: false });
  const id = useId();

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus({ loading: true });
    onChange(undefined);
    try {
      onChange(await connect(environmentId.trim(), apiKey.trim()));
      setStatus({ loading: false });
    } catch (error) {
      setStatus({ loading: false, error: `Could not connect: ${errorMessage(error)}` });
    }
  };

  const edit = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setter(event.target.value);
    if (connection) onChange(undefined);
  };

  return (
    <form className="card" onSubmit={handleConnect} autoComplete="off">
      <h3>{label}</h3>
      <div className="field">
        <div className="field-label">
          <label htmlFor={`${id}-environment`}>Environment ID</label>
          <Tooltip text="Found under Environment settings, or in the app.kontent.ai/<environment-id> URL." />
        </div>
        {/* Password managers treat this as part of a login form because of the key field below;
            these attributes ask the common ones (1Password, LastPass, Bitwarden, Dashlane) to leave it alone. */}
        <input
          id={`${id}-environment`}
          value={environmentId}
          onChange={edit(onEnvironmentIdChange)}
          readOnly={lockedToCurrent}
          placeholder="00000000-0000-0000-0000-000000000000"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
        {/* Always has something to say inside Kontent.ai, so the line never sits empty and using the link
            doesn't move the fields below. */}
        {currentEnvironmentId && (
          <div className="environment-hint">
            {environmentId.trim() === currentEnvironmentId ? (
              <span className="muted">
                <span aria-hidden="true">✓ </span>The environment this app is open in
              </span>
            ) : otherEnvironmentId.trim() === currentEnvironmentId ? (
              // The link isn't offered then: the copy would be into the same environment.
              <span className="muted">Different from the {otherSide}</span>
            ) : (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  onEnvironmentIdChange(currentEnvironmentId);
                  if (connection) onChange(undefined);
                }}
              >
                Use this environment
              </button>
            )}
          </div>
        )}
      </div>
      <div className="field">
        <div className="field-label">
          <label htmlFor={`${id}-key`}>Management API key</label>
          <Tooltip
            text={`A Management API key for this environment, from Project settings > API keys, with these permissions: ${permissions}. ${inDialog ? "It is kept in this dialog only and cleared when you close it." : "It is kept in this browser tab only and cleared when you close or reload it."}`}
          />
        </div>
        {/* Password managers offer to save a password field when the form goes away, which the attributes
            above don't stop. So where the browser can mask a text field, the key is one (see .masked-input);
            elsewhere it stays a password field. Spell checking is off so the key isn't sent to a spelling service. */}
        <input
          id={`${id}-key`}
          type={canMaskText ? "text" : "password"}
          className={canMaskText ? "masked-input" : undefined}
          value={apiKey}
          onChange={edit(setApiKey)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
      </div>
      <button
        type="submit"
        className="btn continue-btn connect-btn"
        disabled={!environmentId.trim() || !apiKey.trim() || status.loading}
      >
        {status.loading && <span className="loading-span" aria-hidden="true" />}
        {status.loading ? "Connecting" : "Connect"}
      </button>
      {connection && (
        <Message kind="ok">
          Connected to <strong>{connection.projectName}</strong>, environment{" "}
          <strong>{connection.environmentName}</strong>
        </Message>
      )}
      {status.error && <Message kind="error">{status.error}</Message>}
    </form>
  );
};
