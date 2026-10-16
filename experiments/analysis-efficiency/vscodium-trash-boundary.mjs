#!/usr/bin/env node
// Actual shipped VSCodium UI -> native file service -> shell.trashItem.
// Only an owned copy of the selected REA checkout's README is eligible for deletion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { _electron } from "playwright-core";
import { verifyStagedElectronHooks } from "./electron-hook-identity.mjs";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    executable: { type: "string" },
    application: { type: "string" },
    "trial-root": { type: "string" },
  },
});
for (const key of ["runtime-root", "executable", "application", "trial-root"])
  assert.ok(values[key], `Missing --${key}`);
const runtime = resolve(values["runtime-root"]);
const trial = resolve(values["trial-root"]);
assert.equal(
  (await readFile(join(trial, "OWNED-BY-REA-3474"), "utf8")).trim(),
  "REA3474 owned disposable verification trial",
);
const { PlaywrightElectronActiveProvider } = await import(
  pathToFileURL(
    join(runtime, "dist/browser/PlaywrightElectronActiveProvider.js"),
  )
);
const { captureElectronScenario } = await import(
  pathToFileURL(
    join(
      runtime,
      "dist/application/javascript/ElectronActiveObservationService.js",
    ),
  )
);
const started = performance.now();
const profile = join(trial, "profile");
const workspace = join(trial, "workspace");
const extensions = join(trial, "extensions");
await mkdir(join(profile, "User"), { recursive: true });
await mkdir(workspace);
await mkdir(extensions);
const target = join(workspace, "README-copy.md");
const original = await readFile(join(runtime, "README.md"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalHash = hash(original);
await writeFile(target, original, { flag: "wx" });
const settings = {
  "files.enableTrash": true,
  "explorer.confirmDelete": false,
  "workbench.startupEditor": "none",
  "window.menuStyle": "custom",
  "window.titleBarStyle": "custom",
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
};
await writeFile(join(profile, "User/settings.json"), JSON.stringify(settings), {
  flag: "wx",
});
let application;
let child;
let probe;
let stagedHookHashes;
let engine;
const controller = new AbortController();
const deadline = setTimeout(
  () => controller.abort(new Error("Verifier deadline")),
  60_000,
);
const trashEvents = () =>
  globalThis
    .__reaElectronActiveSnapshot()
    .events.filter(
      (event) => event.kind === "shell-attempt" && event.event === "trashItem",
    );
const launch = async (options) => {
  const index = options.args.indexOf("-r");
  assert.notEqual(index, -1, "Expected the staged hook require pair");
  stagedHookHashes = await verifyStagedElectronHooks(
    runtime,
    options.args[index + 1],
  );
  application = await _electron.launch(options);
  child = application.process();
  engine = await application.evaluate(({ app }) => ({
    node: process.versions.node,
    electron: process.versions.electron,
    application_path: app.getAppPath(),
  }));
  assert.equal(engine.application_path, resolve(values.application));
  assert.equal(
    await application.evaluate(
      () => typeof globalThis.__reaElectronActiveSnapshot,
    ),
    "function",
    "The canonical active hook must be installed before application actions",
  );
  assert.equal(
    await application.evaluate(
      () => globalThis.__reaElectronActiveSnapshot().hook_error,
    ),
    false,
  );
  const page = await application.firstWindow({ timeout: 20_000 });
  const pageErrors = [];
  page.on("pageerror", (cause) => {
    if (pageErrors.length < 5) pageErrors.push(String(cause).slice(0, 600));
  });
  try {
    await page.locator(".monaco-workbench").waitFor({ timeout: 20_000 });
    const row = page.getByRole("treeitem", { name: /README-copy\.md/ }).first();
    await row.waitFor({ timeout: 15_000 });
    controller.signal.throwIfAborted();
    const before = await application.evaluate(trashEvents);
    assert.deepEqual(
      before,
      [],
      "Startup events cannot prove the requested deletion",
    );
    await row.click({ button: "right" });
    const menu = page.getByRole("menuitem", { name: "Delete", exact: true });
    controller.signal.throwIfAborted();
    await menu.click({ timeout: 5_000 });
    const expires = performance.now() + 5_000;
    let events = await application.evaluate(trashEvents);
    while (events.length === 0 && performance.now() < expires) {
      await page.waitForTimeout(50);
      events = await application.evaluate(trashEvents);
    }
    assert.equal(
      events.length,
      1,
      "The real deletion must reach the hooked shell boundary",
    );
    assert.equal(events[0].phase, "blocked");
    assert.deepEqual(events[0].argument_shapes, ["string"]);
    assert.equal(
      hash(await readFile(target)),
      originalHash,
      "Owned file bytes must remain unchanged",
    );
    assert.deepEqual(pageErrors, []);
    probe = {
      before_trash_count: before.length,
      input_path: target,
      input_sha256: originalHash,
      input_bytes: original.length,
      file_unchanged: true,
      shell: events,
      page_errors: pageErrors,
    };
    return application;
  } catch (cause) {
    await page
      .screenshot({ path: join(trial, "failure.png") })
      .catch(() => undefined);
    const labels = await page
      .locator('[role="treeitem"], [role="menuitem"]')
      .evaluateAll((nodes) =>
        nodes.slice(0, 30).map((node) => ({
          role: node.getAttribute("role"),
          label: (
            node.getAttribute("aria-label") ??
            node.textContent ??
            ""
          ).slice(0, 150),
        })),
      )
      .catch(() => []);
    console.log(JSON.stringify({ ui_failure: String(cause), labels }));
    throw cause;
  }
};
try {
  const result = await captureElectronScenario(
    new PlaywrightElectronActiveProvider(process.env, launch),
    {
      executable_path: resolve(values.executable),
      application_path: resolve(values.application),
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--new-window",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-extensions",
        `--user-data-dir=${profile}`,
        `--extensions-dir=${extensions}`,
        workspace,
      ],
      actions: [
        {
          step_id: "settle-after-delete",
          kind: "wait",
          window_index: 0,
          duration_ms: 100,
        },
      ],
    },
    { signal: controller.signal },
  );
  await writeFile(join(trial, "result.json"), JSON.stringify(result));
  const capture = result.ok
    ? result.value.normalized_result
    : result.error.partialObservation?.capture;
  const retained = capture?.timeline.events.filter(
    (event) => event.kind === "shell-attempt" && event.event === "trashItem",
  );
  if (probe)
    assert.deepEqual(
      retained,
      probe.shell,
      "Retained shared capture must contain the exact blocked attempt",
    );
  console.log(
    JSON.stringify({
      runtime,
      staged_hook_sha256: stagedHookHashes,
      engine,
      settings,
      elapsed_ms: performance.now() - started,
      launch_transport: "standard-staged-argv",
      probe: probe ?? null,
      provider_ok: result.ok,
      deadline_triggered: controller.signal.aborted,
      error: result.ok
        ? null
        : {
            tag: result.error._tag,
            reason: result.error.reason,
            diagnostics: result.error.diagnostics,
          },
      coverage: capture?.coverage,
      retention: capture?.retention,
      workflow_status: result.ok && probe ? "verified" : "partial-or-failed",
    }),
  );
  assert.ok(probe, "Real VSCodium trash attempt was not verified");
  assert.ok(result.ok, "Provider cleanup remains unverified");
} catch (cause) {
  console.log(
    JSON.stringify({ verifier_failure: String(cause), probe: probe ?? null }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (application && child?.exitCode === null && child?.signalCode === null) {
    let timer;
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
    clearTimeout(timer);
  }
}
// The external owned scope may recover leftovers; that is not provider cleanup.
process.exit(process.exitCode ?? 0);
