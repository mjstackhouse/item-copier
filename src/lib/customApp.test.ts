import { expect, test } from "vitest";

import { parseCustomAppSettings } from "./customApp";

const current = "current-env";

test("without settings, only the current environment is known", () => {
  expect(parseCustomAppSettings(current, undefined)).toEqual({
    currentEnvironmentId: current,
    sourceEnvironmentId: undefined,
    targetEnvironmentId: undefined,
  });
});

test("thisEnvironment fills that side with the current environment", () => {
  expect(parseCustomAppSettings(current, { thisEnvironment: "source" }).sourceEnvironmentId).toBe(current);
  expect(parseCustomAppSettings(current, { thisEnvironment: "target" }).targetEnvironmentId).toBe(current);
});

test("takes environment IDs for either side, trimmed", () => {
  const settings = parseCustomAppSettings(current, { thisEnvironment: "source", targetEnvironmentId: " other-env " });
  expect(settings).toMatchObject({ sourceEnvironmentId: current, targetEnvironmentId: "other-env" });
});

test("an explicit environment ID takes precedence over thisEnvironment", () => {
  expect(
    parseCustomAppSettings(current, { thisEnvironment: "target", targetEnvironmentId: "other-env" })
      .targetEnvironmentId,
  ).toBe("other-env");
});

test("ignores keys, unknown sides and values of the wrong kind", () => {
  const settings = parseCustomAppSettings(current, {
    thisEnvironment: "both",
    sourceEnvironmentId: 42,
    targetEnvironmentId: "  ",
    targetManagementApiKey: "secret",
  });
  expect(settings).toEqual({
    currentEnvironmentId: current,
    sourceEnvironmentId: undefined,
    targetEnvironmentId: undefined,
  });
});
