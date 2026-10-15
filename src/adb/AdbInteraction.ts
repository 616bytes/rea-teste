import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type {
  AdbInputAction,
  adbInputSchemas,
} from "../domain/adb/adbDeviceAnalysis.js";
import { err, ok, type Result } from "../domain/result.js";
import type { z } from "zod";
import {
  adbArguments,
  prepareOutputDirectory,
  refuseExistingTarget,
  runAdb,
  runAdbCapture,
} from "./AdbRun.js";
import { parsePngDimensions } from "./AdbShellOutput.js";
import {
  AdbUiHierarchyFormatError,
  extractUiHierarchyDocument,
  isMeaningfulUiNode,
  parseUiHierarchyXml,
  projectUiNode,
  selectUiNodes,
  type AdbUiHierarchy,
} from "./AdbUiHierarchy.js";

const BOOT_PROBE_TIMEOUT_MS = 15_000;
const BOOT_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const UI_DUMP_TIMEOUT_MS = 60_000;
const UI_DUMP_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Nodes parsed for selector resolution; uiautomator dumps stay far below. */
const UI_SELECTOR_MAX_NODES = 20_000;
const SCREEN_TIMEOUT_MS = 60_000;
const SCREEN_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const INPUT_TIMEOUT_MS = 30_000;
const INPUT_MAX_OUTPUT_BYTES = 64 * 1024;

/** The single adb invocation context shared by these operations. */
export interface AdbInteractionContext {
  readonly binary: string;
  readonly serial: string;
  readonly signal: AbortSignal | undefined;
}

const BOOT_PROBE_SCRIPT = String.raw`printf '%s|%s|%s\n' "$(getprop sys.boot_completed)" "$(getprop dev.bootcomplete)" "$(getprop init.svc.bootanim)"`;

const emptyToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** Wait for `sys.boot_completed=1`, tolerating an unreachable booting device. */
export const waitForBoot = async (
  context: AdbInteractionContext,
  input: z.infer<typeof adbInputSchemas.wait_adb_boot>,
) => {
  const operation = "wait_adb_boot";
  const started = Date.now();
  let probes = 0;
  let lastError: string | null = null;
  let properties: [string | null, string | null, string | null] = [
    null,
    null,
    null,
  ];
  for (;;) {
    probes += 1;
    const remaining = input.timeout_ms - (Date.now() - started);
    const ran = await runAdb(
      operation,
      context.serial,
      context.binary,
      adbArguments(context.serial, ["shell", "sh", "-c", BOOT_PROBE_SCRIPT]),
      {
        timeoutMs: Math.max(1_000, Math.min(BOOT_PROBE_TIMEOUT_MS, remaining)),
        maxOutputBytes: BOOT_PROBE_MAX_OUTPUT_BYTES,
      },
      context.signal,
    );
    if (!ran.ok) {
      if (ran.error instanceof AnalysisCancelledError) return ran;
      // An unauthorized device needs the caller; waiting cannot resolve it.
      if (/unauthorized/iu.test(ran.error.message)) return ran;
      lastError = ran.error.message;
    } else {
      const line = ran.value.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
      const fields = line.split("|");
      if (fields.length === 3) {
        properties = [
          emptyToNull(fields[0]),
          emptyToNull(fields[1]),
          emptyToNull(fields[2]),
        ];
        lastError = null;
      } else lastError = `unrecognized boot probe output: ${line}`;
    }
    const waited = Date.now() - started;
    const completed = properties[0] === "1";
    if (completed || waited + input.poll_interval_ms > input.timeout_ms)
      return ok({
        serial: context.serial,
        outcome: completed
          ? ("boot_completed" as const)
          : ("timed_out" as const),
        waited_ms: waited,
        probes,
        sys_boot_completed: properties[0],
        dev_bootcomplete: properties[1],
        init_svc_bootanim: properties[2],
        last_probe_error: lastError,
      });
    try {
      await delay(input.poll_interval_ms, undefined, (context.signal === undefined ? {} : { signal: context.signal }));
    } catch (cause) {
      return err(new AnalysisCancelledError(operation, { cause }));
    }
  }
};

/**
 * Dump the active window hierarchy through a uniquely named device temp file
 * that the same shell removes, so no device file outlives the call.
 */
const UI_DUMP_SCRIPT = String.raw`file=$1
shift
out=$(uiautomator dump "$@" "$file" 2>&1)
if [ ! -s "$file" ]; then
  rm -f "$file"
  printf '%s\n' "$out" >&2
  exit 1
fi
cat "$file"
status=$?
rm -f "$file"
exit $status`;

interface DumpedHierarchy {
  readonly xml: string;
  readonly hierarchy: AdbUiHierarchy;
  readonly capturedAt: string;
}

const dumpHierarchy = async (
  operation: string,
  context: AdbInteractionContext,
  compressed: boolean,
  maxNodes: number,
): Promise<Result<DumpedHierarchy, AnalysisError>> => {
  const devicePath = `/data/local/tmp/rea-ui-${randomBytes(8).toString("hex")}.xml`;
  const capturedAt = new Date().toISOString();
  const ran = await runAdb(
    operation,
    context.serial,
    context.binary,
    adbArguments(context.serial, [
      "shell",
      "sh",
      "-c",
      UI_DUMP_SCRIPT,
      "rea-ui-dump",
      devicePath,
      ...(compressed ? ["--compressed"] : []),
    ]),
    { timeoutMs: UI_DUMP_TIMEOUT_MS, maxOutputBytes: UI_DUMP_MAX_OUTPUT_BYTES },
    context.signal,
  );
  if (!ran.ok) return ran;
  const xml = extractUiHierarchyDocument(ran.value.stdout);
  if (xml === null)
    return err(
      new AnalysisProtocolError(
        "uiautomator dump did not return a <hierarchy> document",
      ),
    );
  try {
    return ok({
      xml,
      hierarchy: parseUiHierarchyXml(xml, maxNodes),
      capturedAt,
    });
  } catch (cause) {
    if (cause instanceof AdbUiHierarchyFormatError)
      return err(new AnalysisProtocolError(cause.message, { cause }));
    throw cause;
  }
};

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

const writeExclusive = async (
  operation: string,
  path: string,
  bytes: Buffer,
): Promise<
  Result<{ local_path: string; bytes: number; sha256: string }, AnalysisError>
> => {
  const existing = await refuseExistingTarget(operation, path);
  if (existing !== undefined) return err(existing);
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (cause) {
    return err(
      new AnalysisOutputError(
        operation,
        `The output file could not be created exclusively: ${path}`,
        { cause },
      ),
    );
  }
  return ok({
    local_path: path,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
};

/** Compact UTC timestamp for file stems: 20261015T013828123Z. */
const timestampStem = (iso: string) => iso.replace(/[-:.]/gu, "");

/**
 * Capture the window hierarchy and, immediately after, one screen frame,
 * sharing one state identifier so elements and pixels can be correlated.
 */
export const captureUiState = async (
  context: AdbInteractionContext,
  input: z.infer<typeof adbInputSchemas.capture_adb_ui_state>,
) => {
  const operation = "capture_adb_ui_state";
  if (input.include_screen && input.output_directory === undefined)
    return err(
      new AnalysisInputError(operation, {
        userMessage:
          "include_screen needs output_directory; pass include_screen=false for an inline-only hierarchy",
      }),
    );
  let directory: string | undefined;
  if (input.output_directory !== undefined) {
    const prepared = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!prepared.ok) return prepared;
    directory = prepared.value;
  }
  const dumped = await dumpHierarchy(
    operation,
    context,
    input.compressed,
    UI_SELECTOR_MAX_NODES,
  );
  if (!dumped.ok) return dumped;
  const { hierarchy, capturedAt, xml } = dumped.value;
  const stateId =
    timestampStem(capturedAt) +
    (input.state_label === undefined ? "" : `-${input.state_label}`);

  let screen = null;
  if (input.include_screen && directory !== undefined) {
    const screenCapturedAt = new Date().toISOString();
    const captured = await runAdbCapture(
      operation,
      context.serial,
      context.binary,
      adbArguments(context.serial, ["exec-out", "screencap", "-p"]),
      { timeoutMs: SCREEN_TIMEOUT_MS, maxOutputBytes: SCREEN_MAX_OUTPUT_BYTES },
      context.signal,
    );
    if (!captured.ok) return captured;
    const dimensions = parsePngDimensions(captured.value.stdout);
    if (dimensions.width === null)
      return err(
        new AnalysisProtocolError(
          "screencap did not return a PNG payload; the device may not expose a display",
        ),
      );
    const written = await writeExclusive(
      operation,
      join(directory, `${stateId}.png`),
      captured.value.stdout,
    );
    if (!written.ok) return written;
    screen = {
      ...written.value,
      captured_at: screenCapturedAt,
      width: dimensions.width,
      height: dimensions.height,
    };
  }
  let hierarchyFile = null;
  if (directory !== undefined) {
    const written = await writeExclusive(
      operation,
      join(directory, `${stateId}.xml`),
      Buffer.from(xml, "utf8"),
    );
    if (!written.ok) return written;
    hierarchyFile = written.value;
  }
  const selected =
    input.node_filter === "all"
      ? hierarchy.nodes
      : hierarchy.nodes.filter(isMeaningfulUiNode);
  const nodes = selected.slice(0, input.max_nodes).map(projectUiNode);
  return ok({
    serial: context.serial,
    state_id: stateId,
    hierarchy_captured_at: capturedAt,
    rotation: hierarchy.rotation,
    node_count: hierarchy.node_count,
    node_filter: input.node_filter,
    nodes,
    nodes_returned: nodes.length,
    coverage:
      hierarchy.truncated || nodes.length < selected.length
        ? ("partial" as const)
        : ("complete" as const),
    hierarchy_file: hierarchyFile,
    screen,
  });
};

/** `input text` reads `%s` as a space; spaces must be sent that way. */
const encodeInputText = (text: string) => text.replaceAll(" ", "%s");

interface PlannedInput {
  readonly argv: readonly string[];
  readonly resolvedNode: ReturnType<typeof projectUiNode> | null;
}

const planInput = async (
  operation: string,
  context: AdbInteractionContext,
  action: AdbInputAction,
): Promise<Result<PlannedInput, AnalysisError>> => {
  switch (action.type) {
    case "tap":
      return ok({
        argv: ["input", "tap", String(action.x), String(action.y)],
        resolvedNode: null,
      });
    case "long_press":
      return ok({
        argv: [
          "input",
          "swipe",
          String(action.x),
          String(action.y),
          String(action.x),
          String(action.y),
          String(action.duration_ms),
        ],
        resolvedNode: null,
      });
    case "swipe":
      return ok({
        argv: [
          "input",
          "swipe",
          String(action.from.x),
          String(action.from.y),
          String(action.to.x),
          String(action.to.y),
          String(action.duration_ms),
        ],
        resolvedNode: null,
      });
    case "text":
      return ok({
        argv: ["input", "text", encodeInputText(action.text)],
        resolvedNode: null,
      });
    case "key":
      return ok({
        argv: [
          "input",
          "keyevent",
          typeof action.key === "number"
            ? String(action.key)
            : `KEYCODE_${action.key}`,
        ],
        resolvedNode: null,
      });
    case "tap_element": {
      const dumped = await dumpHierarchy(
        operation,
        context,
        false,
        UI_SELECTOR_MAX_NODES,
      );
      if (!dumped.ok) return dumped;
      const matches = selectUiNodes(
        dumped.value.hierarchy.nodes,
        action.selector,
      );
      if (matches.length === 0)
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            context.serial,
            `No UI node on the current screen matches ${JSON.stringify(action.selector)}`,
          ),
        );
      if (matches.length > 1 && action.match_index === undefined)
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            context.serial,
            `${String(matches.length)} UI nodes match ${JSON.stringify(action.selector)}; pass match_index to choose one`,
          ),
        );
      const node = matches[action.match_index ?? 0];
      if (node === undefined)
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            context.serial,
            `match_index ${String(action.match_index)} exceeds the ${String(matches.length)} matching nodes`,
          ),
        );
      if (node.center === null)
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            context.serial,
            `The matching node has no parseable bounds: ${node.bounds_source ?? "absent"}`,
          ),
        );
      return ok({
        argv: ["input", "tap", String(node.center.x), String(node.center.y)],
        resolvedNode: projectUiNode(node),
      });
    }
  }
};

/** Execute input actions in order, stopping at the first failure. */
export const sendInput = async (
  context: AdbInteractionContext,
  input: z.infer<typeof adbInputSchemas.send_adb_input>,
) => {
  const operation = "send_adb_input";
  const executed: {
    index: number;
    action: AdbInputAction;
    command: string[];
    resolved_node: ReturnType<typeof projectUiNode> | null;
  }[] = [];
  let failure: { index: number; code: string; message: string } | null = null;
  for (const [index, action] of input.actions.entries()) {
    if (index > 0 && input.settle_ms > 0) {
      try {
        await delay(input.settle_ms, undefined, (context.signal === undefined ? {} : { signal: context.signal }));
      } catch (cause) {
        return err(new AnalysisCancelledError(operation, { cause }));
      }
    }
    const planned = await planInput(operation, context, action);
    const ran = planned.ok
      ? await runAdb(
          operation,
          context.serial,
          context.binary,
          adbArguments(context.serial, ["shell", ...planned.value.argv]),
          {
            timeoutMs: INPUT_TIMEOUT_MS,
            maxOutputBytes: INPUT_MAX_OUTPUT_BYTES,
          },
          context.signal,
        )
      : planned;
    if (!ran.ok) {
      if (ran.error instanceof AnalysisCancelledError) return ran;
      failure = { index, code: ran.error._tag, message: ran.error.message };
      break;
    }
    if (!planned.ok) break;
    // Some builds print `input` argument errors while still exiting 0.
    const diagnostic = `${ran.value.stdout}
${ran.value.stderr}`.trim();
    if (/Error:|Exception|Usage: input/iu.test(diagnostic)) {
      failure = {
        index,
        code: "AnalysisProtocolError",
        message: diagnostic.slice(0, 512),
      };
      break;
    }
    executed.push({
      index,
      action,
      command: [...planned.value.argv],
      resolved_node: planned.value.resolvedNode,
    });
  }
  return ok({
    serial: context.serial,
    status: failure === null ? ("completed" as const) : ("stopped" as const),
    executed,
    failure,
  });
};
