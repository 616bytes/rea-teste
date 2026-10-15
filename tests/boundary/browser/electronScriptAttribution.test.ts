import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

type Event = { readonly method: string; readonly params: unknown };
const context = (id: unknown, frameId: unknown): Event => ({
  method: "Runtime.executionContextCreated",
  params: { context: { id, auxData: { frameId } } },
});
const destroyed: Event = {
  method: "Runtime.executionContextDestroyed",
  params: { executionContextId: 1 },
};
const cleared: Event = {
  method: "Runtime.executionContextsCleared",
  params: {},
};

const inspect = async (
  root: string,
  trace: readonly Event[],
  includeSources = false,
) => {
  const main = pathToFileURL(join(root, "index.html")).href;
  const browser = await startFakeCdpBrowser({
    electronFileUrl: main,
    eventsBeforeReply: ["Runtime.enable", "Debugger.enable"],
    commandResult: ({ method }) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: { id: "frame-main", url: main },
              childFrames: [
                {
                  frame: {
                    id: "frame-child",
                    parentId: "frame-main",
                    url: main,
                  },
                },
              ],
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }) =>
      method === "Runtime.enable"
        ? []
        : method === "Debugger.enable"
          ? trace.map((event) => ({
              ...event,
              ...(sessionId === undefined ? {} : { sessionId }),
            }))
          : undefined,
  });
  browsers.push(browser);
  const result = await new CdpElectronProvider().inspectPage(
    inspectElectronPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "electron-page",
      observation_ms: 0,
      include_script_sources: includeSources,
    }),
  );
  if (!result.ok) throw result.error;
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Runtime.evaluate",
  );
  expect(
    browser.commands.filter(
      ({ method }) => method === "Debugger.getScriptSource",
    ),
  ).toHaveLength(includeSources ? result.value.scripts.total : 0);
  return result.value.scripts;
};

const fixture = async () => {
  const root = await createTestTempDirectory(
    "rea-electron-script-attribution-",
  );
  temporary.push(root);
  await writeFile(join(root, "index.html"), "<html></html>");
  await writeFile(join(root, "app.js"), "export const app = true;");
  const script = (scriptId: string, executionContextId: unknown): Event => ({
    method: "Debugger.scriptParsed",
    params: {
      scriptId,
      executionContextId,
      url: pathToFileURL(join(root, "app.js")).href,
      hash: scriptId,
    },
  });
  return { root, script };
};

describe("Electron script attribution over simulated CDP", () => {
  it.each([destroyed, cleared])(
    "retains frame identity and script key after $method",
    async (teardown) => {
      const { root, script } = await fixture();
      const trace = [context(1, "frame-main"), script("old", 1)];
      const control = await inspect(root, trace);
      expect(control.items[0]?.frame_id).toBe("frame-main");
      expect(await inspect(root, [...trace, teardown])).toEqual(control);
    },
  );

  it.each([destroyed, cleared])(
    "clears live mappings without relabeling retained scripts after $method",
    async (teardown) => {
      const { root, script } = await fixture();
      const result = await inspect(
        root,
        [
          context(1, "frame-main"),
          script("old", 1),
          teardown,
          script("between", 1),
          context(1, "frame-child"),
          script("new", 1),
        ],
        true,
      );
      expect(
        Object.fromEntries(
          result.items.map((item) => [item.cdp_hash, item.frame_id]),
        ),
      ).toEqual({
        old: "frame-main",
        between: null,
        new: "frame-child",
      });
      expect(result.items.every((item) => item.source.included)).toBe(true);
    },
  );

  it("keeps absent, malformed, later and out-of-scope relationships unknown", async () => {
    const { root, script } = await fixture();
    const result = await inspect(root, [
      script("later", 1),
      context(1, "frame-main"),
      script("missing", undefined),
      script("string-id", "1"),
      script("fractional-id", 1.5),
      context(2, 7),
      script("malformed-frame", 2),
      context(3, "frame-foreign"),
      script("foreign-frame", 3),
    ]);
    expect(result.total).toBe(6);
    expect(result.items.every((item) => item.frame_id === null)).toBe(true);
  });
});
