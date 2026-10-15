import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { IDENTIFIER_PATTERN } from "../stringPatterns.js";

/**
 * Device serials as adb prints them: emulator-5554, USB identifiers, and
 * host:port transports. The pattern keeps arguments free of whitespace and
 * quotes; argv is positional in the provider, so this is admission hygiene
 * rather than injection defense.
 */
const deviceSerialSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[^\x00\s"']+$/u,
    "Device serial cannot contain whitespace or quotes",
  );

/**
 * Android package names as Package Manager reports them. System entries can
 * be a single segment (`android`), so at least one identifier is required.
 */
const packageNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/u,
    "Package name must be dot-separated Java identifiers",
  );

/** Text states emitted by adb's ConnectionState formatter. */
export const ADB_DEVICE_STATES = [
  "no permissions",
  "unauthorized",
  "authorizing",
  "offline",
  "recovery",
  "sideload",
  "connecting",
  "bootloader",
  "device",
  "unknown",
  "host",
  "rescue",
  "detached",
] as const;
export const adbDeviceStateSchema = z.enum(ADB_DEVICE_STATES);
export type AdbDeviceState = (typeof ADB_DEVICE_STATES)[number];

const screenCoordinateSchema = z.number().int().min(0).max(32_767);
const screenPointSchema = z.strictObject({
  x: screenCoordinateSchema,
  y: screenCoordinateSchema,
});

/** Named Android key events accepted by `input keyevent KEYCODE_<name>`. */
export const ADB_NAMED_KEYS = [
  "HOME",
  "BACK",
  "APP_SWITCH",
  "MENU",
  "ENTER",
  "TAB",
  "DEL",
  "FORWARD_DEL",
  "ESCAPE",
  "SEARCH",
  "SPACE",
  "DPAD_UP",
  "DPAD_DOWN",
  "DPAD_LEFT",
  "DPAD_RIGHT",
  "DPAD_CENTER",
  "PAGE_UP",
  "PAGE_DOWN",
  "MOVE_HOME",
  "MOVE_END",
  "VOLUME_UP",
  "VOLUME_DOWN",
  "POWER",
  "WAKEUP",
  "SLEEP",
] as const;

const uiSelectorTextSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00]*$/u, "Selector values cannot contain NUL");

/** Exact-match UI selector; every provided field must equal the node fact. */
const uiSelectorSchema = z
  .strictObject({
    resource_id: uiSelectorTextSchema.optional(),
    text: uiSelectorTextSchema.optional(),
    content_desc: uiSelectorTextSchema.optional(),
    class_name: uiSelectorTextSchema.optional(),
  })
  .refine(
    (selector) => Object.values(selector).some((value) => value !== undefined),
    "Selector needs at least one of resource_id, text, content_desc, class_name",
  );

/**
 * One input event. `input text` cannot type non-ASCII text and turns `%s`
 * into a space, so text is limited to printable ASCII without `%s`.
 */
export const adbInputActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("tap"),
    x: screenCoordinateSchema,
    y: screenCoordinateSchema,
  }),
  z.strictObject({
    type: z.literal("tap_element"),
    selector: uiSelectorSchema,
    match_index: z
      .number()
      .int()
      .min(0)
      .max(4_999)
      .optional()
      .describe("Which document-order match to tap when several nodes match"),
  }),
  z.strictObject({
    type: z.literal("long_press"),
    x: screenCoordinateSchema,
    y: screenCoordinateSchema,
    duration_ms: z.number().int().min(100).max(10_000).default(800),
  }),
  z.strictObject({
    type: z.literal("swipe"),
    from: screenPointSchema,
    to: screenPointSchema,
    duration_ms: z.number().int().min(1).max(10_000).default(300),
  }),
  z.strictObject({
    type: z.literal("text"),
    text: z
      .string()
      .min(1)
      .max(1_000)
      .regex(/^[\x20-\x7e]+$/u, "input text accepts printable ASCII only")
      .refine(
        (value) => !value.includes("%s"),
        "input text turns %s into a space",
      ),
  }),
  z.strictObject({
    type: z.literal("key"),
    key: z.union([z.enum(ADB_NAMED_KEYS), z.number().int().min(0).max(1_000)]),
  }),
]);
export type AdbInputAction = z.infer<typeof adbInputActionSchema>;

const keyStringSchema = z.string().min(1).max(256);
const keyPattern = /^[A-Za-z0-9._\x2d]+$/u;

/**
 * Caller intent for ADB-backed device inspection and acquisition.
 *
 * REA never installs platform tools, starts an emulator, or manages devices;
 * every operation addresses devices the caller already connected, through the
 * adb binary the caller selected.
 */
export const adbInputSchemas = {
  inspect_adb_client: z.strictObject({}),
  list_adb_devices: z.strictObject({}),
  inspect_adb_device: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  list_adb_packages: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    scope: z
      .enum(["all", "third_party", "system"])
      .default("all")
      .describe(
        "Package scope: all packages, third-party only (-3), or system only (-s)",
      ),
  }),
  pull_adb_package: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe(
      "Installed package name whose APK set is pulled",
    ),
    output_directory: localPathStringSchema.describe(
      "Local directory for the pulled APK set; REA creates a package-named subdirectory inside it",
    ),
  }),
  read_adb_logcat: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    count: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(500)
      .describe("Number of most recent lines to read (logcat -d -t)"),
    buffer: z
      .enum(["main", "system", "radio", "events", "crash"])
      .default("main")
      .describe("Log buffer to read (logcat -b)"),
    pid: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Restrict to one process id (logcat --pid)"),
  }),
  inspect_adb_package: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe("Installed package to inspect"),
  }),
  pull_adb_file: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    device_path: z
      .string()
      .min(1)
      .regex(/^\/[^\x00]*$/u, "Device path must be absolute")
      .describe("Absolute device filesystem path to pull"),
    output_directory: localPathStringSchema.describe(
      "Local directory for the pulled file; must not already contain the file",
    ),
  }),
  push_adb_file: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    local_path: localPathStringSchema.describe(
      "Existing local regular file to push",
    ),
    device_path: z
      .string()
      .min(1)
      .regex(/^\/[^\x00]*$/u, "Device path must be absolute")
      .describe("Absolute destination path on the device"),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Allow replacing an existing device file; refused by default"),
  }),
  capture_adb_screen: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    output_directory: localPathStringSchema.describe(
      "Local directory for the captured PNG; must not already contain it",
    ),
  }),
  list_adb_processes: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  list_adb_directory: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    device_path: z
      .string()
      .min(1)
      .regex(/^\/[^\x00]*$/u, "Device path must be absolute")
      .describe(
        "Absolute device directory path to list, including hidden children",
      ),
  }),
  list_adb_features: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  list_adb_services: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  inspect_adb_display: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  inspect_adb_window: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
  }),
  read_adb_setting: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    namespace: z
      .enum(["system", "secure", "global"])
      .describe("Settings namespace to read"),
    key: keyStringSchema
      .regex(keyPattern, "Setting keys are restricted to identifiers")
      .describe("Setting key to read"),
  }),
  collect_adb_bugreport: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    output_directory: localPathStringSchema.describe(
      "Local directory for the bugreport archive; REA writes exactly one new zip into it",
    ),
  }),
  resolve_adb_packages: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    query: z
      .string()
      .min(2)
      .max(256)
      .describe(
        "Case-insensitive substring matched against installed package names (e.g. whatsapp)",
      ),
  }),
  install_adb_package: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    apk_path: localPathStringSchema.describe(
      "Existing local APK file to install",
    ),
    replace: z
      .boolean()
      .default(false)
      .describe(
        "Request replacement mode and keep existing app data if present (adb install -r); does not establish whether the app was already installed",
      ),
  }),
  uninstall_adb_package: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe("Installed package to uninstall"),
  }),
  start_adb_app: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe(
      "Installed package whose launcher activity is started",
    ),
  }),
  start_adb_activity: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    action: z
      .string()
      .min(1)
      .max(256)
      .regex(
        IDENTIFIER_PATTERN,
        "Intent action must be a dotted identifier such as android.intent.action.VIEW",
      )
      .describe("Intent action to start"),
    data_uri: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[^\x00\s]+$/u, "Data URI cannot contain whitespace or NUL")
      .optional()
      .describe("Intent data URI (-d)"),
    component: z
      .string()
      .min(1)
      .max(512)
      .regex(
        /^[A-Za-z0-9._\x2d]+(\/[A-Za-z0-9._\x2d]*)?$/u,
        "Component must be package/activity form",
      )
      .optional()
      .describe("Explicit component to start (-n)"),
    extras: z
      .array(
        z.strictObject({
          key: keyStringSchema
            .regex(keyPattern, "Extra keys are identifiers")
            .describe("Extra key"),
          type: z
            .enum(["string", "boolean", "int", "long", "float"])
            .describe("Extra value type"),
          value: z
            .string()
            .min(1)
            .max(2048)
            .regex(/^[^\x00]*$/u, "Extra values cannot contain NUL")
            .describe("Extra value as text, parsed per type"),
        }),
      )
      .max(16)
      .default([])
      .describe("Typed intent extras (--es/--ez/--ei/--el/--ef)"),
  }),
  stop_adb_app: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    package: packageNameSchema.describe(
      "Package whose processes are force-stopped",
    ),
  }),
  wait_adb_boot: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(120_000)
      .describe("Longest time to wait for sys.boot_completed=1"),
    poll_interval_ms: z
      .number()
      .int()
      .min(250)
      .max(30_000)
      .default(2_000)
      .describe("Delay between boot-property probes"),
  }),
  capture_adb_ui_state: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    output_directory: localPathStringSchema
      .optional()
      .describe(
        "Local directory for the raw hierarchy XML and screenshot; required when include_screen is true",
      ),
    state_label: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{1,64}$/u,
        "State label must be 1-64 letters, digits, '_' or '-'",
      )
      .optional()
      .describe(
        "Caller navigation-state name appended to the timestamped file stem",
      ),
    include_screen: z
      .boolean()
      .default(true)
      .describe(
        "Capture a PNG frame immediately after the hierarchy dump (needs output_directory)",
      ),
    compressed: z
      .boolean()
      .default(false)
      .describe("Pass --compressed to uiautomator, omitting layout-only nodes"),
    node_filter: z
      .enum(["meaningful", "all"])
      .default("meaningful")
      .describe(
        "Inline nodes: meaningful keeps nodes with an id, text, description, or click/scroll affordance; all keeps every node",
      ),
    max_nodes: z
      .number()
      .int()
      .min(1)
      .max(5_000)
      .default(300)
      .describe("Most inline nodes returned; the XML file keeps every node"),
  }),
  send_adb_input: z.strictObject({
    serial: deviceSerialSchema.describe(
      "Device serial exactly as `adb devices` reports it",
    ),
    actions: z
      .array(adbInputActionSchema)
      .min(1)
      .max(64)
      .describe(
        "Input actions executed in order; the returned executed list can be replayed as-is",
      ),
    settle_ms: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(300)
      .describe("Delay after each action before the next one"),
  }),
} as const;

/** Supported ADB-backed operations. */
export type AdbOperation = keyof typeof adbInputSchemas;
/** Validated ADB requests carry their selected operation. */
export type AdbRequest = {
  [Name in AdbOperation]: {
    operation: Name;
    input: z.infer<(typeof adbInputSchemas)[Name]>;
  };
}[AdbOperation];

/** Validate operation and input together so their types remain correlated. */
export const adbRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_adb_client"),
    input: adbInputSchemas.inspect_adb_client,
  }),
  z.strictObject({
    operation: z.literal("list_adb_devices"),
    input: adbInputSchemas.list_adb_devices,
  }),
  z.strictObject({
    operation: z.literal("inspect_adb_device"),
    input: adbInputSchemas.inspect_adb_device,
  }),
  z.strictObject({
    operation: z.literal("list_adb_packages"),
    input: adbInputSchemas.list_adb_packages,
  }),
  z.strictObject({
    operation: z.literal("pull_adb_package"),
    input: adbInputSchemas.pull_adb_package,
  }),
  z.strictObject({
    operation: z.literal("read_adb_logcat"),
    input: adbInputSchemas.read_adb_logcat,
  }),
  z.strictObject({
    operation: z.literal("inspect_adb_package"),
    input: adbInputSchemas.inspect_adb_package,
  }),
  z.strictObject({
    operation: z.literal("pull_adb_file"),
    input: adbInputSchemas.pull_adb_file,
  }),
  z.strictObject({
    operation: z.literal("push_adb_file"),
    input: adbInputSchemas.push_adb_file,
  }),
  z.strictObject({
    operation: z.literal("capture_adb_screen"),
    input: adbInputSchemas.capture_adb_screen,
  }),
  z.strictObject({
    operation: z.literal("list_adb_processes"),
    input: adbInputSchemas.list_adb_processes,
  }),
  z.strictObject({
    operation: z.literal("list_adb_directory"),
    input: adbInputSchemas.list_adb_directory,
  }),
  z.strictObject({
    operation: z.literal("list_adb_features"),
    input: adbInputSchemas.list_adb_features,
  }),
  z.strictObject({
    operation: z.literal("list_adb_services"),
    input: adbInputSchemas.list_adb_services,
  }),
  z.strictObject({
    operation: z.literal("inspect_adb_display"),
    input: adbInputSchemas.inspect_adb_display,
  }),
  z.strictObject({
    operation: z.literal("inspect_adb_window"),
    input: adbInputSchemas.inspect_adb_window,
  }),
  z.strictObject({
    operation: z.literal("read_adb_setting"),
    input: adbInputSchemas.read_adb_setting,
  }),
  z.strictObject({
    operation: z.literal("collect_adb_bugreport"),
    input: adbInputSchemas.collect_adb_bugreport,
  }),
  z.strictObject({
    operation: z.literal("resolve_adb_packages"),
    input: adbInputSchemas.resolve_adb_packages,
  }),
  z.strictObject({
    operation: z.literal("install_adb_package"),
    input: adbInputSchemas.install_adb_package,
  }),
  z.strictObject({
    operation: z.literal("uninstall_adb_package"),
    input: adbInputSchemas.uninstall_adb_package,
  }),
  z.strictObject({
    operation: z.literal("start_adb_app"),
    input: adbInputSchemas.start_adb_app,
  }),
  z.strictObject({
    operation: z.literal("start_adb_activity"),
    input: adbInputSchemas.start_adb_activity,
  }),
  z.strictObject({
    operation: z.literal("stop_adb_app"),
    input: adbInputSchemas.stop_adb_app,
  }),
  z.strictObject({
    operation: z.literal("wait_adb_boot"),
    input: adbInputSchemas.wait_adb_boot,
  }),
  z.strictObject({
    operation: z.literal("capture_adb_ui_state"),
    input: adbInputSchemas.capture_adb_ui_state,
  }),
  z.strictObject({
    operation: z.literal("send_adb_input"),
    input: adbInputSchemas.send_adb_input,
  }),
]);

const client = z.strictObject({
  binary_path: z.string().min(1),
  path_source: z.enum(["environment", "path"]),
  version: z.string().min(1).nullable(),
  installed_path: z.string().min(1).nullable(),
});

const savedFile = z.strictObject({
  local_path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const uiBounds = z.strictObject({
  left: z.number().int(),
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
});

/** Compact uiautomator node: absent fields were empty or unreported. */
const uiNodeResult = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  parent: z.number().int().nonnegative().nullable(),
  class_name: z.string().nullable(),
  resource_id: z.string().nullable(),
  text: z.string().nullable(),
  content_desc: z.string().nullable(),
  package_name: z.string().nullable(),
  bounds: uiBounds.nullable(),
  bounds_source: z.string().nullable(),
  center: z
    .strictObject({ x: z.number().int(), y: z.number().int() })
    .nullable(),
  /** Boolean attributes reported as true. */
  flags: z.array(z.string()),
  /** Boolean attributes the dump omitted or reported with another value. */
  unreported_flags: z.array(z.string()),
});

const device = z.strictObject({
  serial: z.string().min(1),
  state: adbDeviceStateSchema,
  transport: z.enum(["usb", "tcp", "unknown"]),
  product: z.string().nullable(),
  model: z.string().nullable(),
  device: z.string().nullable(),
  transport_id: z.number().int().positive().nullable(),
  /**
   * Inferred device kind with its evidence basis. The serial prefix and the
   * `device:` metadata line are observations; the kind itself is derived.
   */
  kind: z.enum(["emulator", "physical", "unknown"]),
  kind_basis: z.enum(["emulator_serial_prefix", "usb_transport", "none"]),
});

const pulledArtifact = z.strictObject({
  device_path: z.string().min(1),
  file_name: z.string().min(1),
  local_path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  role: z.enum(["base", "split", "unknown"]),
  role_basis: z.literal("file_name"),
});

const pullFailure = z.strictObject({
  device_path: z.string().min(1).nullable(),
  stage: z.enum(["resolve_paths", "pull", "digest"]),
  message: z.string().min(1),
});

/** Portable ADB observations with explicit identity and coverage limitations. */
export const adbResultSchemas = {
  inspect_adb_client: z.strictObject({
    client,
    /**
     * `adb version` never contacts the adb server; this tool starts nothing.
     * Recorded explicitly so the session keeps the distinction observable.
     */
    contacted_adb_server: z.literal(false),
  }),
  list_adb_devices: z.strictObject({
    client,
    devices: z.array(device),
    /**
     * Starting the local adb server is an adb client behavior on first use;
     * REA observes whichever server state the caller's environment has.
     */
    may_have_started_adb_server: z.boolean(),
  }),
  inspect_adb_device: z.strictObject({
    client,
    serial: z.string().min(1),
    properties: z.array(
      z.strictObject({ name: z.string().min(1), value: z.string().min(1) }),
    ),
    property_count: z.number().int().nonnegative(),
    emulator_observed: z.boolean().nullable(),
  }),
  list_adb_packages: z.strictObject({
    client,
    serial: z.string().min(1),
    scope: z.enum(["all", "third_party", "system"]),
    packages: z.array(
      z.strictObject({
        package_name: packageNameSchema,
        /** Device filesystem path; not a host-local path. */
        base_apk_device_path: z.string().min(1),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  pull_adb_package: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
    output_directory: z.string().min(1),
    artifacts: z.array(pulledArtifact),
    failures: z.array(pullFailure),
    coverage: z.enum(["complete", "partial"]),
  }),
  read_adb_logcat: z.strictObject({
    client,
    serial: z.string().min(1),
    count: z.number().int().positive(),
    buffer: z.enum(["main", "system", "radio", "events", "crash"]),
    pid: z.number().int().positive().nullable(),
    lines: z.array(z.string()),
    total_bytes: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
  }),
  inspect_adb_package: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
    version_name: z.string().nullable(),
    version_code: z
      .string()
      .regex(/^-?\d+$/u)
      .nullable()
      .describe(
        "Long version code exactly as dumpsys package prints it; may exceed the JSON safe-integer range",
      ),
    first_install_time: z.string().nullable(),
    last_update_time: z.string().nullable(),
    installer_package_name: z.string().nullable(),
    user_id: z.number().int().nullable(),
    pkg_flags: z.string().nullable(),
    requested_permissions_count: z.number().int().nonnegative().nullable(),
    coverage: z.enum(["complete", "partial"]),
  }),
  pull_adb_file: z.strictObject({
    client,
    serial: z.string().min(1),
    device_path: z.string().min(1),
    local_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  push_adb_file: z.strictObject({
    client,
    serial: z.string().min(1),
    local_path: z.string().min(1),
    device_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    device_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    overwritten: z.boolean(),
    device_digest_source: z.enum(["device_sha256sum", "unavailable"]),
  }),
  capture_adb_screen: z.strictObject({
    client,
    serial: z.string().min(1),
    local_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
  list_adb_processes: z.strictObject({
    client,
    serial: z.string().min(1),
    columns: z.string().nullable(),
    processes: z.array(
      z.strictObject({
        user: z.string(),
        pid: z.number().int().nonnegative(),
        ppid: z.number().int().nullable(),
        rss: z.number().int().nullable(),
        state: z.string().nullable(),
        name: z.string(),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  list_adb_directory: z.strictObject({
    client,
    serial: z.string().min(1),
    device_path: z.string().min(1),
    entries: z.array(
      z.strictObject({
        name: z.string().min(1),
        kind: z.enum(["directory", "file", "symlink", "other"]),
        permissions: z.string().nullable(),
        owner: z.string().nullable(),
        group: z.string().nullable(),
        bytes: z.number().int().nullable(),
        date: z.string().nullable(),
        link_target: z.string().nullable(),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  list_adb_features: z.strictObject({
    client,
    serial: z.string().min(1),
    features: z.array(
      z.strictObject({
        name: z.string().min(1),
        version: z.number().int().nullable(),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  list_adb_services: z.strictObject({
    client,
    serial: z.string().min(1),
    services: z.array(
      z.strictObject({
        name: z.string().min(1),
        interface: z.string().nullable(),
      }),
    ),
    unparsed_lines: z.array(z.string().min(1)),
    coverage: z.enum(["complete", "partial"]),
  }),
  inspect_adb_display: z.strictObject({
    client,
    serial: z.string().min(1),
    physical_size: z.strictObject({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    override_size: z
      .strictObject({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable(),
    physical_density: z.number().int().positive().nullable(),
    override_density: z.number().int().positive().nullable(),
  }),
  inspect_adb_window: z.strictObject({
    client,
    serial: z.string().min(1),
    focused_window: z.string().nullable(),
    focused_app: z.string().nullable(),
    observed_lines: z.array(z.string().min(1)),
  }),
  read_adb_setting: z.strictObject({
    client,
    serial: z.string().min(1),
    namespace: z.enum(["system", "secure", "global"]),
    key: z.string().min(1),
    value: z.string().nullable(),
    device_reported_null: z.boolean(),
  }),
  collect_adb_bugreport: z.strictObject({
    client,
    serial: z.string().min(1),
    local_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    adb_reported_path: z.string().nullable(),
  }),
  resolve_adb_packages: z.strictObject({
    client,
    serial: z.string().min(1),
    query: z.string().min(1),
    matches: z.array(
      z.strictObject({
        package_name: packageNameSchema,
        base_apk_device_path: z.string().min(1),
      }),
    ),
    exact_match: z.boolean(),
    coverage: z.enum(["complete", "partial"]),
  }),
  install_adb_package: z.strictObject({
    client,
    serial: z.string().min(1),
    apk_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    replace_requested: z.boolean(),
    replaced: z.boolean().nullable(),
  }),
  uninstall_adb_package: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
  }),
  start_adb_app: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
    component: z.string().min(1),
    started_activity: z.string().nullable(),
    reported_activity: z.string().nullable().optional(),
    reported_status: z.string().nullable().optional(),
  }),
  start_adb_activity: z.strictObject({
    client,
    serial: z.string().min(1),
    action: z.string().min(1),
    data_uri: z.string().nullable(),
    component: z.string().nullable(),
    extras: z.array(
      z.strictObject({
        key: z.string().min(1),
        type: z.enum(["string", "boolean", "int", "long", "float"]),
        value: z.string(),
      }),
    ),
    started_activity: z.string().nullable(),
    reported_activity: z.string().nullable().optional(),
    reported_status: z.string().nullable().optional(),
  }),
  stop_adb_app: z.strictObject({
    client,
    serial: z.string().min(1),
    package_name: packageNameSchema,
  }),
  wait_adb_boot: z.strictObject({
    client,
    serial: z.string().min(1),
    outcome: z.enum(["boot_completed", "timed_out"]),
    waited_ms: z.number().int().nonnegative(),
    probes: z.number().int().positive(),
    /** Last observed values; null when the property was empty or unread. */
    sys_boot_completed: z.string().nullable(),
    dev_bootcomplete: z.string().nullable(),
    init_svc_bootanim: z.string().nullable(),
    /** Last adb failure while the device was unreachable, if any. */
    last_probe_error: z.string().nullable(),
  }),
  capture_adb_ui_state: z.strictObject({
    client,
    serial: z.string().min(1),
    state_id: z.string().min(1),
    hierarchy_captured_at: z.string().min(1),
    rotation: z.number().int().nullable(),
    node_count: z.number().int().nonnegative(),
    node_filter: z.enum(["meaningful", "all"]),
    nodes: z.array(uiNodeResult),
    nodes_returned: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
    hierarchy_file: savedFile.nullable(),
    screen: savedFile
      .extend({
        captured_at: z.string().min(1),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
      })
      .nullable(),
  }),
  send_adb_input: z.strictObject({
    client,
    serial: z.string().min(1),
    status: z.enum(["completed", "stopped"]),
    executed: z.array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        action: adbInputActionSchema,
        command: z.array(z.string()),
        resolved_node: uiNodeResult.nullable(),
      }),
    ),
    failure: z
      .strictObject({
        index: z.number().int().nonnegative(),
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .nullable(),
  }),
} as const;

/** Launch-attempt facts retained when Activity Manager does not report success. */
export type AdbActivityStartPartialObservation =
  | {
      readonly provider_id: "adb";
      readonly operation: "start_adb_app";
      readonly result: z.infer<typeof adbResultSchemas.start_adb_app>;
    }
  | {
      readonly provider_id: "adb";
      readonly operation: "start_adb_activity";
      readonly result: z.infer<typeof adbResultSchemas.start_adb_activity>;
    };

/** Acquired package facts retained when cancellation leaves caller-owned output. */
export type AdbPackagePullPartialObservation = {
  readonly provider_id: "adb";
  readonly operation: "pull_adb_package";
  readonly result: z.infer<typeof adbResultSchemas.pull_adb_package>;
};

/** Acquired file facts retained when publication, digest verification or cleanup fails. */
export type AdbAcquiredFilePartialObservation =
  | {
      readonly provider_id: "adb";
      readonly operation: "pull_adb_file";
      readonly result: {
        readonly client: z.infer<
          typeof adbResultSchemas.pull_adb_file
        >["client"];
        readonly serial: string;
        readonly local_path: string;
        readonly device_path: string;
        readonly digest_status: "unknown";
      };
    }
  | {
      readonly provider_id: "adb";
      readonly operation: "collect_adb_bugreport";
      readonly result:
        | z.infer<typeof adbResultSchemas.collect_adb_bugreport>
        | {
            readonly client: z.infer<
              typeof adbResultSchemas.collect_adb_bugreport
            >["client"];
            readonly serial: string;
            readonly local_path: string;
            readonly adb_reported_path: string;
            readonly digest_status: "unknown";
          };
    };
