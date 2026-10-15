import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const serviceWorkerReferences = (source: string) =>
  analyzeJavaScriptStaticSource(source)
    .references.filter(({ kind }) => kind === "service-worker")
    .map(({ specifier, expression }) => [specifier, expression]);

describe("static callee boundary matching", () => {
  it("matches complete callee members without suffix collisions", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      win.loadFile("./window.html");
      BrowserWindow.loadURL("https://app.example.test");
      navigator.serviceWorker.register("./worker.js");
      loadFile("./bare.html");
      win?.loadURL("https://optional.example.test");

      uploadFile("./upload.html");
      preloadFile("./preload.html");
      downloadURL("https://download.example.test");
      reloadURL("https://reload.example.test");
      notloadURL("https://other.example.test");
      myserviceWorker.register("./not-worker.js");
    `);

    expect(
      analysis.role_paths.map(({ path, mechanism }) => [path, mechanism]),
    ).toEqual([
      ["./window.html", "call:win.loadFile"],
      ["https://app.example.test", "call:BrowserWindow.loadURL"],
      ["./bare.html", "call:loadFile"],
      ["https://optional.example.test", "call:win.loadURL"],
    ]);
    // The document base URL is unknown, so the script path stays unresolved.
    expect(
      analysis.references
        .filter(({ kind }) => kind === "service-worker")
        .map(({ specifier, expression }) => [specifier, expression]),
    ).toEqual([[null, 'navigator.serviceWorker.register("./worker.js")']]);
    expect(
      analysis.endpoints
        .filter(({ mechanism }) => mechanism.endsWith("loadURL"))
        .map(({ value }) => value),
    ).toEqual(["https://app.example.test", "https://optional.example.test"]);
  });

  it("reads registrations through every unmodified navigator global alias", () => {
    // The registering document base URL is unknown, so each script path stays
    // an unresolved expression.
    expect(
      serviceWorkerReferences(`
        navigator.serviceWorker.register("./bare.js");
        window.navigator.serviceWorker.register("./window.js");
        self.navigator.serviceWorker.register("./self.js");
        globalThis.navigator.serviceWorker.register("./global.js");
        navigator.serviceWorker?.register("./optional-member.js");
        navigator?.serviceWorker.register("./optional-navigator.js");
        window?.navigator.serviceWorker.register("./optional-window.js");
        navigator.serviceWorker["register"]("./computed.js");
      `),
    ).toEqual([
      [null, 'navigator.serviceWorker.register("./bare.js")'],
      [null, 'window.navigator.serviceWorker.register("./window.js")'],
      [null, 'self.navigator.serviceWorker.register("./self.js")'],
      [null, 'globalThis.navigator.serviceWorker.register("./global.js")'],
      [null, 'navigator.serviceWorker?.register("./optional-member.js")'],
      [null, 'navigator?.serviceWorker.register("./optional-navigator.js")'],
      [
        null,
        'window?.navigator.serviceWorker.register("./optional-window.js")',
      ],
      [null, 'navigator.serviceWorker["register"]("./computed.js")'],
    ]);
  });

  it.each([
    {
      label: "a shadowed local navigator object",
      source: `
        const navigator = { serviceWorker: { register: (path) => load(path) } };
        navigator.serviceWorker.register("./local.js");
      `,
    },
    {
      label: "an imported serviceWorker binding",
      source: `
        import { serviceWorker } from "./registry.js";
        serviceWorker.register("./imported.js");
      `,
    },
    {
      label: "an unrelated object path ending in serviceWorker",
      source: `app.vendor.serviceWorker.register("./vendor.js");`,
    },
    {
      label: "an overwritten navigator.serviceWorker",
      source: `
        navigator.serviceWorker = shim;
        navigator.serviceWorker.register("./shim.js");
      `,
    },
    {
      label: "a navigator.serviceWorker overwritten through window",
      source: `
        window.navigator.serviceWorker = shim;
        navigator.serviceWorker.register("./shim.js");
      `,
    },
    {
      label: "an overwritten navigator global",
      source: `
        navigator = fake;
        navigator.serviceWorker.register("./fake.js");
      `,
    },
    {
      label: "a navigator parameter",
      source: `
        function install(navigator) {
          navigator.serviceWorker.register("./parameter.js");
        }
      `,
    },
  ])("attributes no service worker to $label", ({ source }) => {
    expect(serviceWorkerReferences(source)).toEqual([]);
  });

  it("resolves only a module-relative registration URL", () => {
    expect(
      serviceWorkerReferences(`
        navigator.serviceWorker.register(new URL("./module.js", import.meta.url));
        navigator.serviceWorker.register(new URL("/rooted.js", import.meta.url));
        navigator.serviceWorker.register(new URL("./other.js", location.href));
        navigator.serviceWorker.register(scriptUrl);
        navigator.serviceWorker.register();
      `),
    ).toEqual([
      // `import.meta.url` names this module, so the relative path resolves.
      ["./module.js", null],
      // An origin-rooted path, an unknown base, a non-literal argument, and a
      // missing argument each leave the registered script unresolved.
      [
        null,
        'navigator.serviceWorker.register(new URL("/rooted.js", import.meta.url))',
      ],
      [
        null,
        'navigator.serviceWorker.register(new URL("./other.js", location.href))',
      ],
      [null, "navigator.serviceWorker.register(scriptUrl)"],
      [null, "navigator.serviceWorker.register()"],
    ]);
  });
});
