import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { AdbProvider } from "./AdbProvider.js";
import { adbRequestSchema } from "../domain/adb/adbDeviceAnalysis.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const it = test.skipIf(process.platform === "win32");

const VERSION_BLOCK =
  "printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-stub\\nInstalled as %s\\n' \"$0\"";

const UI_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2340]"><node index="0" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[100,200][300,260]" /><node index="1" text="Sign in" resource-id="com.example:id/login_alt" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[100,300][300,360]" /></node></hierarchy>`;

/**
 * adb stub: `$3` is the subcommand after `-s <serial>`. Shell scripts arrive
 * as `shell sh -c <script> <name> <args...>`; argv is logged per call.
 */
const writeAdbStub = async (bootValue = "1") => {
  const root = await mkdtemp(join("/tmp", "rea-adb-ui-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "adb");
  const log = join(root, "argv.log");
  const dump = join(root, "dump.xml");
  await writeFile(dump, UI_DUMP);
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
printf '%s ' "$@" >> ${log}; printf '\\n' >> ${log}
if [ "$3" = "shell" ] && [ "$4" = "sh" ] && [ "$7" = "rea-ui-dump" ]; then
  cat ${dump}
  printf 'UI hierchary dumped to: %s\\n' "$8"
  exit 0
fi
if [ "$3" = "shell" ] && [ "$4" = "sh" ]; then
  printf '${bootValue}|1|stopped\\n'
  exit 0
fi
if [ "$3" = "exec-out" ]; then
  printf '\\211PNG\\r\\n\\032\\n\\0\\0\\0\\rIHDR\\0\\0\\0\\004\\0\\0\\0\\003'
  exit 0
fi
if [ "$3" = "shell" ] && [ "$4" = "input" ]; then exit 0; fi
exit 1
`,
    { mode: 0o755 },
  );
  await chmod(binary, 0o755);
  return { binary, root, log };
};

const execute = async (binary: string, request: unknown) => {
  const parsed = adbRequestSchema.parse(request);
  return new AdbProvider({ environment: { REA_ADB_PATH: binary } }).execute(
    parsed,
  );
};

const resultOf = async (binary: string, request: unknown) => {
  const result = await execute(binary, request);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.result as Record<string, unknown>;
};

it("reports boot completion from the device boot properties", async () => {
  const { binary } = await writeAdbStub();
  expect(
    await resultOf(binary, {
      operation: "wait_adb_boot",
      input: { serial: "emulator-5554" },
    }),
  ).toMatchObject({
    outcome: "boot_completed",
    probes: 1,
    sys_boot_completed: "1",
    init_svc_bootanim: "stopped",
    last_probe_error: null,
  });
});

it("times out with the last observed properties while still booting", async () => {
  const { binary } = await writeAdbStub("");
  expect(
    await resultOf(binary, {
      operation: "wait_adb_boot",
      input: {
        serial: "emulator-5554",
        timeout_ms: 1_000,
        poll_interval_ms: 250,
      },
    }),
  ).toMatchObject({ outcome: "timed_out", sys_boot_completed: null });
});

it("captures hierarchy XML and screenshot under one state id", async () => {
  const { binary, root, log } = await writeAdbStub();
  const output = join(root, "states");
  const result = await resultOf(binary, {
    operation: "capture_adb_ui_state",
    input: {
      serial: "emulator-5554",
      output_directory: output,
      state_label: "login",
    },
  });
  expect(result.state_id).toMatch(/^\d{8}T\d{9}Z-login$/u);
  expect(result).toMatchObject({
    node_count: 3,
    nodes_returned: 2,
    coverage: "complete",
    screen: { width: 4, height: 3 },
  });
  const xml = await readFile(
    join(output, `${String(result.state_id)}.xml`),
    "utf8",
  );
  expect(xml.endsWith("</hierarchy>")).toBe(true);
  expect(
    (await readFile(join(output, `${String(result.state_id)}.png`))).subarray(
      1,
      4,
    ),
  ).toEqual(Buffer.from("PNG"));
  expect(await readFile(log, "utf8")).toMatch(
    /rea-ui-dump \/data\/local\/tmp\/rea-ui-[0-9a-f]{16}\.xml/u,
  );
});

it("refuses a screenshot without an output directory", async () => {
  const { binary } = await writeAdbStub();
  const result = await execute(binary, {
    operation: "capture_adb_ui_state",
    input: { serial: "emulator-5554" },
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
    });
});

it("sends input as fixed argv and resolves element selectors", async () => {
  const { binary, log } = await writeAdbStub();
  const result = await resultOf(binary, {
    operation: "send_adb_input",
    input: {
      serial: "emulator-5554",
      settle_ms: 0,
      actions: [
        {
          type: "tap_element",
          selector: { resource_id: "com.example:id/login" },
        },
        { type: "text", text: "hello world" },
        { type: "key", key: "BACK" },
        { type: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
      ],
    },
  });
  expect(result).toMatchObject({ status: "completed", failure: null });
  const executed = result.executed as { command: string[] }[];
  expect(executed.map(({ command }) => command)).toEqual([
    ["input", "tap", "200", "230"],
    ["input", "text", "hello%sworld"],
    ["input", "keyevent", "KEYCODE_BACK"],
    ["input", "swipe", "1", "2", "3", "4", "300"],
  ]);
  expect(await readFile(log, "utf8")).toContain(
    "-s emulator-5554 shell input tap 200 230",
  );
});

it("stops at an ambiguous selector without tapping", async () => {
  const { binary, log } = await writeAdbStub();
  const result = await resultOf(binary, {
    operation: "send_adb_input",
    input: {
      serial: "emulator-5554",
      actions: [
        { type: "key", key: "HOME" },
        { type: "tap_element", selector: { text: "Sign in" } },
      ],
      settle_ms: 0,
    },
  });
  expect(result).toMatchObject({
    status: "stopped",
    failure: { index: 1, code: "AnalysisUnsupportedTargetError" },
  });
  expect(await readFile(log, "utf8")).not.toContain("input tap");
});
