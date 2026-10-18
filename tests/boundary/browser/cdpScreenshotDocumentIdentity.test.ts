import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
describe("screenshot committed document identity", () => {
  it.each([
    ["missing screenshot data", {}],
    ["invalid base64 screenshot data", { data: "not base64%%%" }],
  ])("reports %s as a protocol error", async (_label, result) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? result : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const observation = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(observation).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });

  it.each([
    { offset: 8, value: 14 },
    { offset: 16, value: 0x8000_0000 },
    { offset: 20, value: 0x8000_0000 },
  ])("rejects invalid screenshot IHDR metadata", async ({ offset, value }) => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    );
    bytes.writeUInt32BE(value, offset);
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
  it.each(["loader-main", "loader-reloaded"])(
    "distinguishes %s for the same URL",
    async (screenshotDocumentLoader) => {
      const browser = await startFakeCdpBrowser({ screenshotDocumentLoader });
      onTestFinished(async () => {
        await browser.close();
      });
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      if (screenshotDocumentLoader === "loader-main")
        expect(result.ok).toBe(true);
      else
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
    },
  );
});

it.each([23, -23])(
  "preserves native capture options at current document scroll coordinate %s",
  async (pageX) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? {
              cssVisualViewport: {
                pageX,
                pageY: 47,
                clientWidth: 320,
                clientHeight: 200,
                scale: 2,
              },
            }
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result.ok).toBe(true);
    expect(
      browser.commands.find(({ method }) => method === "Page.captureScreenshot")
        ?.params,
    ).toEqual({
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    expect(
      browser.commands.some(
        ({ method }) =>
          method.startsWith("Emulation.") || method === "Runtime.evaluate",
      ),
    ).toBe(false);
  },
);

it.each([
  {},
  {
    cssVisualViewport: {
      pageX: null,
      pageY: 0,
      clientWidth: 320,
      clientHeight: 200,
    },
  },
  {
    cssVisualViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: 0,
      clientHeight: 200,
    },
  },
  {
    cssVisualViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: 320,
      clientHeight: null,
    },
  },
])(
  "rejects invalid current-viewport metrics before reading pixels: %j",
  async (metrics) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics" ? metrics : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.some(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toBe(false);
  },
);

it.each(["pageX", "pageY", "clientWidth", "clientHeight"] as const)(
  "rejects a changed %s between viewport selection and pixel capture",
  async (field) => {
    let reads = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) => {
        if (method !== "Page.getLayoutMetrics") return undefined;
        const viewport = {
          pageX: 0,
          pageY: 0,
          clientWidth: 320,
          clientHeight: 200,
        };
        if (++reads > 1) viewport[field] += 1;
        return { cssVisualViewport: viewport };
      },
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "target_changed" },
    });
    expect(reads).toBe(2);
  },
);
