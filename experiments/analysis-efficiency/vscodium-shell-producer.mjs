#!/usr/bin/env node
// Real UI + production shell patch, with a test recorder. This does not exercise
// the full hook/provider: packaged startup and navigation are separate gaps.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright-core";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime-root", "executable", "application", "trial-root"].map((key) => [
      key,
      { type: "string" },
    ]),
  ),
});
for (const key of ["runtime-root", "executable", "application", "trial-root"])
  assert.ok(values[key], `Missing --${key}`);
const runtime = resolve(values["runtime-root"]);
const trial = resolve(values["trial-root"]);
const { safeElectronEnvironment } = await import(
  pathToFileURL(
    join(runtime, "dist/browser/PlaywrightElectronActiveProvider.js"),
  )
);
assert.equal(
  (await readFile(join(trial, "OWNED-BY-REA-3474"), "utf8")).trim(),
  "REA3474 owned disposable verification trial",
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
const inputHash = hash(original);
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
const boundary = join(trial, "electron-active-hook-boundaries.cjs");
await copyFile(
  join(runtime, "scripts/electron-active-hook-boundaries.cjs"),
  boundary,
);
const boundaryHash = hash(await readFile(boundary));
assert.equal(
  boundaryHash,
  hash(
    await readFile(
      join(runtime, "scripts/electron-active-hook-boundaries.cjs"),
    ),
  ),
);
const preload = join(trial, "shell-producer-preload.cjs");
await writeFile(
  preload,
  `const electron = require("electron");
const { createElectronActiveBoundaryPatches } = require(${JSON.stringify(boundary)});
const events = []; let dropped = 0;
const unused = () => { throw new Error("Unexpected non-shell observer path"); };
if (typeof electron.shell.trashItem !== "function") throw new Error("Missing real shell.trashItem");
createElectronActiveBoundaryPatches({
  identity: unused, patchEmitter: unused, processType: unused, recordIpc: unused, shape: unused,
  recordRuntime(kind, event, phase, meta) {
    if (kind !== "shell-attempt" || event !== "trashItem") return;
    if (events.length >= 16) { dropped += 1; return; }
    events.push({ kind, event, phase, error: meta.error,
      argument_count: meta.argument_shape_values.length,
      matches_owned_path: meta.argument_shape_values[0] === ${JSON.stringify(target)} });
  }
}).patchShell(electron.shell);
// Pin the native module for this test's lifetime; omit it from the snapshot.
globalThis.__reaShellProducerElectron = electron;
globalThis.__reaShellProducerSnapshot = () => ({ events: events.slice(), dropped });
`,
  { flag: "wx" },
);

let application;
let page;
let probe;
let engine;
let closeStatus = "not-launched";
let failure;
const pageErrors = [];
try {
  application = await _electron.launch({
    executablePath: resolve(values.executable),
    env: safeElectronEnvironment(process.env, randomUUID()),
    args: [
      "-r",
      preload,
      resolve(values.application),
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
    timeout: 30_000,
  });
  engine = await application.evaluate(({ app }) => ({
    node: process.versions.node,
    electron: process.versions.electron,
    application_path: app.getAppPath(),
    full_hook_installed:
      typeof globalThis.__reaElectronActiveSnapshot === "function",
    shell_probe_installed:
      typeof globalThis.__reaShellProducerSnapshot === "function",
  }));
  assert.equal(engine.application_path, resolve(values.application));
  assert.equal(engine.full_hook_installed, false);
  assert.equal(engine.shell_probe_installed, true);
  page = await application.firstWindow({ timeout: 20_000 });
  page.on("pageerror", (cause) => {
    if (pageErrors.length < 5) pageErrors.push(String(cause).slice(0, 600));
  });
  await page.locator(".monaco-workbench").waitFor({ timeout: 20_000 });
  const row = page.getByRole("treeitem", { name: /README-copy\.md/ }).first();
  await row.waitFor({ timeout: 15_000 });
  const before = await application.evaluate(() =>
    globalThis.__reaShellProducerSnapshot(),
  );
  assert.deepEqual(before, { events: [], dropped: 0 });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete", exact: true })
    .click({ timeout: 5_000 });
  let after = await application.evaluate(() =>
    globalThis.__reaShellProducerSnapshot(),
  );
  const expires = performance.now() + 5_000;
  while (after.events.length === 0 && performance.now() < expires) {
    await page.waitForTimeout(50);
    after = await application.evaluate(() =>
      globalThis.__reaShellProducerSnapshot(),
    );
  }
  assert.deepEqual(after, {
    events: [
      {
        kind: "shell-attempt",
        event: "trashItem",
        phase: "blocked",
        error: true,
        argument_count: 1,
        matches_owned_path: true,
      },
    ],
    dropped: 0,
  });
  assert.equal(hash(await readFile(target)), inputHash);
  assert.deepEqual(pageErrors, []);
  probe = {
    input_path: target,
    input_sha256: inputHash,
    input_bytes: original.length,
    before_trash_count: 0,
    file_unchanged: true,
    observation: after,
    page_errors: pageErrors,
  };
} catch (cause) {
  failure = String(cause);
  if (page) {
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
    console.log(JSON.stringify({ ui_failure: failure, labels }));
  }
} finally {
  if (application) {
    let timer;
    closeStatus = await Promise.race([
      application.close().then(
        () => "api-completed",
        () => "api-failed",
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("deadline"), 5_000);
      }),
    ]);
    clearTimeout(timer);
  }
}
console.log(
  JSON.stringify({
    scope: "production-shell-boundary-with-test-recorder",
    runtime,
    executable: resolve(values.executable),
    application: resolve(values.application),
    boundary_sha256: boundaryHash,
    engine,
    settings,
    elapsed_ms: performance.now() - started,
    probe: probe ?? null,
    failure: failure ?? null,
    close_status: closeStatus,
    scenario_ok: probe !== undefined,
    full_hook_provider_workflow: "NOT_EXECUTED",
  }),
);
process.exit(probe && closeStatus === "api-completed" ? 0 : 1);
