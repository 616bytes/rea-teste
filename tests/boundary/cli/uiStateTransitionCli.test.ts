import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { deriveUiStateTransition } from "../../../src/application/uiStateTransition/UiStateTransitionService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  uiPageEvidence,
  uiPageInspection,
} from "../../fixtures/uiStateTransition.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives browser UI state transitions through the public CLI without a browser provider",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ui-transition-cli-");
    const request = join(root, "transition.json");
    const before = uiPageEvidence();
    const after = uiPageEvidence(
      uiPageInspection({
        capture_window: {
          started_at: "2026-10-15T12:00:01.000Z",
          ended_at: "2026-10-15T12:00:01.000Z",
          observation_ms: 0,
        },
      }),
    );
    const input = {
      before,
      after,
      action: {
        action_id: "save",
        description: "External Pyppeteer clicked Save.",
        provenance: "caller-declared" as const,
      },
      selection: { offset: 1, limit: 1 },
    };
    const expected = deriveUiStateTransition(input);
    if (!expected.ok) throw expected.error;
    await writeFile(request, JSON.stringify(input));
    const response = await cli.run({
      arguments: ["derive-ui-state-transition", request, "--json"],
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const evidence = parseEvidence(response.json);
    expect(evidence).toEqual(expected.value);
    expect(evidence.normalized_result).toMatchObject({
      before: {
        accessibility: {
          items: [{ node_id: "ax-save", name: "Save" }],
          coverage: { next_offset: 2 },
        },
      },
    });
  },
);
