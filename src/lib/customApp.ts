/**
 * Running as a Kontent.ai custom app: the environment the app is opened in, and the optional JSON
 * settings from Environment settings > Custom apps. API keys are never read from the settings: Kontent.ai
 * advises against storing them there, and this tool's keys can create, edit and delete content.
 */
export type CustomAppSettings = {
  /** The environment the custom app is opened in. */
  readonly currentEnvironmentId: string;
  /** Environment IDs to fill in on the Connect step. */
  readonly sourceEnvironmentId?: string;
  readonly targetEnvironmentId?: string;
};

/** Custom apps run in an iframe inside app.kontent.ai; a standalone tab is its own top-level window. */
export const insideKontentAi = (): boolean => window.self !== window.top;

/**
 * Reads the settings, which may contain:
 * - `thisEnvironment`: "source" or "target", to fill that side with the environment the app is opened in
 * - `sourceEnvironmentId`, `targetEnvironmentId`: environment IDs for either side, for example the
 *   environment content is regularly copied to. They take precedence over `thisEnvironment`.
 * Anything else, including values of the wrong kind, is ignored.
 */
export const parseCustomAppSettings = (currentEnvironmentId: string, appConfig: unknown): CustomAppSettings => {
  const config = appConfig && typeof appConfig === "object" ? (appConfig as Record<string, unknown>) : {};
  const id = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const side = config.thisEnvironment;

  return {
    currentEnvironmentId,
    sourceEnvironmentId: id(config.sourceEnvironmentId) ?? (side === "source" ? currentEnvironmentId : undefined),
    targetEnvironmentId: id(config.targetEnvironmentId) ?? (side === "target" ? currentEnvironmentId : undefined),
  };
};

// The SDK waits for Kontent.ai to answer, without a time limit.
const contextTimeoutMs = 5000;

/** The custom app settings, or undefined when they can't be read, so the tool works as if standalone. */
export const loadCustomAppSettings = async (): Promise<CustomAppSettings | undefined> => {
  try {
    // Loaded only inside Kontent.ai, so the standalone tool doesn't download it.
    const { getCustomAppContext } = await import("@kontent-ai/custom-app-sdk");
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), contextTimeoutMs));
    const result = await Promise.race([getCustomAppContext(), timeout]);
    if (!result || result.isError || !result.context.environmentId) return undefined;
    return parseCustomAppSettings(result.context.environmentId, result.context.appConfig);
  } catch {
    return undefined;
  }
};
