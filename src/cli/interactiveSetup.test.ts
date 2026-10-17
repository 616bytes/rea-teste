import { expect, it } from "vitest";
import type { SetupResult } from "../application/SetupTypes.js";
import { describeReadyCapabilities } from "./interactiveSetup.js";

const resultWithProviders = (
  availableProviders: readonly string[],
): SetupResult => ({
  status: "ready",
  plannedActions: [],
  appliedActions: [],
  clients: {},
  doctor: {
    healthy: true,
    environment_healthy: true,
    scope: {
      mode: "explicit",
      clients: [],
      providers: [],
      skill: false,
      target: null,
    },
    availableProviders,
  },
  clientStates: [],
});

it("sends JEB-only setups to the dedicated JEB lane instead of analyze", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders(["jeb"]),
    [],
    "rea",
  );
  expect(lines).toContain("│  Deep analysis: Jeb");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines).toContain("│  JEB: rea inspect-jeb-client");
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});

it.each(["hopper", "kuna"])(
  "keeps analyze guidance when %s is ready alongside JEB",
  (provider) => {
    const lines = describeReadyCapabilities(
      resultWithProviders([provider, "jeb"]),
      [],
      "rea",
    );
    expect(lines).toContain("│  CLI: rea analyze /path/to/app");
    expect(lines).toContain("│  JEB: rea inspect-jeb-client");
  },
);

it("suggests capabilities when no provider is ready", () => {
  const lines = describeReadyCapabilities(resultWithProviders([]), [], "rea");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines.some((line) => line.startsWith("│  JEB:"))).toBe(false);
});
