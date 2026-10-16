import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  DEDICATED_WORKER_SESSION_ID,
  DEDICATED_WORKER_TARGET_ID,
  startFakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const inspect = async (
  browser: Awaited<ReturnType<typeof startFakeCdpBrowser>>,
) =>
  await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

it("records dedicated worker requests from their flattened CDP session", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
      }),
    );
    if (!result.ok) throw result.error;

    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      url: `${browser.allowedOrigin}/worker-api?token=worker-secret`,
      worker_target_id: DEDICATED_WORKER_TARGET_ID,
      status: 200,
      mime_type: "application/json",
    });
    const pageRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "request-1",
    );
    expect(pageRequest?.worker_target_id).toBe(null);
    // A worker session REA never admitted must not contribute requests.
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "rogue-session-request",
      ),
    ).toBe(false);

    expect(
      browser.commands.filter(
        ({ method, sessionId }) =>
          method === "Network.enable" &&
          sessionId === DEDICATED_WORKER_SESSION_ID,
      ),
    ).toHaveLength(1);
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        sessionId: "session-1",
        params: expect.objectContaining({
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }),
      }),
    );
    // The capture releases the worker sessions it admitted.
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.detachFromTarget",
        params: { sessionId: DEDICATED_WORKER_SESSION_ID },
      }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.disable",
        sessionId: DEDICATED_WORKER_SESSION_ID,
      }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        params: expect.objectContaining({ autoAttach: false }),
      }),
    );
  } finally {
    await browser.close();
  }
});

it("reads worker JSON response bodies through the worker session", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
        include_json_body_shapes: true,
      }),
    );
    if (!result.ok) throw result.error;

    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      worker_target_id: DEDICATED_WORKER_TARGET_ID,
      body_shapes: { status: "included" },
    });
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.getResponseBody",
        sessionId: DEDICATED_WORKER_SESSION_ID,
        params: { requestId: "worker-request-1" },
      }),
    );
  } finally {
    await browser.close();
  }
});

it("retains worker requests after their worker terminates mid-capture", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    terminateDedicatedWorker: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
        include_json_body_shapes: true,
      }),
    );
    if (!result.ok) throw result.error;

    expect(result.value.network.requests).toContainEqual(
      expect.objectContaining({
        request_id: "worker-request-1",
        worker_target_id: DEDICATED_WORKER_TARGET_ID,
      }),
    );
    // Events after the worker's detach are no longer admitted.
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "worker-request-after-detach",
      ),
    ).toBe(false);
    // The detached worker's body is reported unavailable, not silently read.
    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      body_shapes: { status: "unavailable" },
    });
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("the issuing worker session detached"),
    );
    expect(
      browser.commands.some(
        ({ method, sessionId }) =>
          method === "Network.getResponseBody" &&
          sessionId === DEDICATED_WORKER_SESSION_ID,
      ),
    ).toBe(false);
  } finally {
    await browser.close();
  }
});

it("keeps page capture working when worker auto-attach is unavailable", async () => {
  const browser = await startFakeCdpBrowser({
    commandError(command) {
      if (command.method !== "Target.setAutoAttach") return undefined;
      return { code: -32_601, message: "Method not found" };
    },
  });
  try {
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(result.value.network.requests).toContainEqual(
      expect.objectContaining({ request_id: "request-1" }),
    );
    expect(result.value.limitations).toContainEqual(
      "Target.setAutoAttach was unavailable from this browser target.",
    );
    expect(result.value.completeness.attach_limited_sections).toContain(
      "workers",
    );
  } finally {
    await browser.close();
  }
});
