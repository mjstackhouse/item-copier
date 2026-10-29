import { useState } from "react";

import { type Connection, connect, errorMessage } from "../lib/kontent";

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
      {sameEnvironment && <p className="message error">Source and target are the same environment.</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={!source || !target || !!sameEnvironment} onClick={onNext}>
          Next: choose items
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
      <label>
        Environment ID
        <input value={environmentId} onChange={edit(setEnvironmentId)} placeholder="00000000-0000-0000-0000-000000000000" />
      </label>
      <label>
        Management API key
        <input type="password" value={apiKey} onChange={edit(setApiKey)} />
      </label>
      <button type="submit" disabled={!environmentId.trim() || !apiKey.trim() || status.loading}>
        {status.loading ? "Connecting…" : "Connect"}
      </button>
      {connection && (
        <p className="message ok">
          Connected to <strong>{connection.projectName}</strong>, environment <strong>{connection.environmentName}</strong>
        </p>
      )}
      {status.error && <p className="message error">{status.error}</p>}
    </form>
  );
};
