import { useId, useState } from "react";

import { type Connection, connect, errorMessage } from "../lib/kontent";
import { Message, Tooltip } from "./ui";

type Props = {
  readonly source?: Connection;
  readonly target?: Connection;
  readonly onSourceChange: (connection: Connection | undefined) => void;
  readonly onTargetChange: (connection: Connection | undefined) => void;
  readonly onNext: () => void;
};

export const ConnectStep = ({ source, target, onSourceChange, onTargetChange, onNext }: Props) => {
  const sameEnvironment = source && target && source.environmentId === target.environmentId;

  return (
    <section>
      <h2>Connect environments</h2>
      <p className="hint">
        Use Management API keys. Keys stay in this browser tab only and are cleared when you close or reload it.
      </p>
      <div className="two-columns">
        <EnvironmentForm label="Copy from (source)" connection={source} onChange={onSourceChange} />
        <EnvironmentForm label="Copy to (target)" connection={target} onChange={onTargetChange} />
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

type FormProps = {
  readonly label: string;
  readonly connection?: Connection;
  readonly onChange: (connection: Connection | undefined) => void;
};

const EnvironmentForm = ({ label, connection, onChange }: FormProps) => {
  const [environmentId, setEnvironmentId] = useState(connection?.environmentId ?? "");
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
          onChange={edit(setEnvironmentId)}
          placeholder="00000000-0000-0000-0000-000000000000"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
      </div>
      <div className="field">
        <div className="field-label">
          <label htmlFor={`${id}-key`}>Management API key</label>
          <Tooltip text="A Management API key for this environment, from Project settings > API keys. It is kept in this browser tab only and cleared when you close or reload it." />
        </div>
        <input id={`${id}-key`} type="password" value={apiKey} onChange={edit(setApiKey)} />
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
          Connected to <strong>{connection.projectName}</strong>, environment <strong>{connection.environmentName}</strong>
        </Message>
      )}
      {status.error && <Message kind="error">{status.error}</Message>}
    </form>
  );
};
