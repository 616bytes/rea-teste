import { z } from "zod";
import { fixedTupleSchema } from "../fixedTupleSchema.js";
import { localPathStringSchema } from "../localPath.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import { tlsKeyLogReportSchema } from "./tlsKeyLog.js";

const argument = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes("\0"), "NUL is not an argument character");
const captureInputShape = z.strictObject({
  path: localPathStringSchema.describe("Absolute local capture path"),
  fields: z
    .array(argument)
    .max(1024)
    .min(1)
    .describe(
      "TShark field names to return, e.g. ip.addr, usb.endpoint_address, btatt.opcode; frame.number is always included. With tls_key_log_path, only the packet/HTTP metadata fields listed in the packet-captures guide are admitted; named credentials are removed. Select http.request.method with http.request.uri to distinguish CONNECT authority-form.",
    ),
  display_filter: argument
    .nullable()
    .default(null)
    .describe(
      "Optional Wireshark display filter (-Y), applied within the read limit. Must be omitted or null with tls_key_log_path to prevent credential probes through match counts.",
    ),
  decode_as: z
    .array(argument)
    .max(1024)
    .default([])
    .describe("Explicit TShark decode-as selections, e.g. tcp.port==8888,http"),
  packet_limit: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .nullable()
    .default(null)
    .describe(
      "Maximum input packets to read before filtering; omitted scans to EOF within resource limits",
    ),
  two_pass: z
    .boolean()
    .default(true)
    .describe(
      "Use two-pass analysis for fields requiring later packets; false requests a single pass",
    ),
  match_offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Skip this many matching packets after filtering; default 0"),
  match_limit: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(50)
    .describe(
      "Return at most this many matching packets after filtering; default 50. Null explicitly returns all remaining matches within producer resource limits.",
    ),
  tls_key_log_path: localPathStringSchema
    .optional()
    .describe(
      "Optional absolute local NSS key log (SSLKEYLOGFILE format) written by the caller's own TLS client. A private read-only copy is passed to TShark as tls.keylog_file; its owner removes it after the run and retains cleanup retries on failure. Secrets, client randoms and line text are never returned. Only reviewed packet/HTTP metadata fields are admitted (http.request.uri requires http.request.method); known authorization/cookie fields and fields containing URL userinfo are removed and listed in redactions. Generic headers, decoded authentication, payload/raw fields, unreviewed fields and all display filters are refused. Producer diagnostic text is withheld.",
    ),
});
// Bound UTF-8 selector text, terminators, option names and 64-bit argv pointers
// before Set/flatMap expansion. 32 KiB reserves headroom below Linux execve's
// 32-page argv+environment floor; ambient environments can still exhaust it.
export const withinPacketCaptureSelectorBudget = (input: {
  fields: readonly string[];
  decode_as: readonly string[];
  display_filter: string | null;
}): boolean => {
  if (input.fields.length > 1024 || input.decode_as.length > 1024) return false;
  let bytes = 0;
  for (const selections of [input.fields, input.decode_as])
    for (const value of selections) {
      bytes += Buffer.byteLength(value, "utf8") + 20;
      if (bytes > 32768) return false;
    }
  if (input.display_filter !== null)
    bytes += Buffer.byteLength(input.display_filter, "utf8") + 20;
  return bytes <= 32768;
};
export const packetCaptureSelectorBudgetIssue = {
  message:
    "Packet selectors exceed the 32 KiB encoded argument budget; reduce fields, decode-as rules or filter text.",
};
// Wireshark registrations carrying all or a decoded part of an Authorization,
// Proxy-Authorization, Cookie or Set-Cookie header (HTTP/3 needs nghttp3).
// Other selections are separately restricted to reviewed metadata below.
const TRANSPORT_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  "http.authorization",
  "http.proxy_authorization",
  "http.authbasic",
  "http.authcitrix.user",
  "http.authcitrix.domain",
  "http.authcitrix.password",
  "http.authcitrix.session",
  "http.cookie",
  "http.cookie_pair",
  "http.set_cookie",
  "http2.headers.authorization",
  "http2.headers.proxy_authorization",
  "http2.headers.cookie",
  "http2.headers.set_cookie",
  "http3.headers.authorization",
  "http3.headers.proxy_authorization",
  "http3.headers.cookie",
  "http3.headers.set_cookie",
]);

const isTransportCredentialField = (field: string): boolean =>
  TRANSPORT_CREDENTIAL_FIELDS.has(field.replace(/^@/u, ""));

/** Recognize credential syntax in URL/authority fields, without inspecting application data. */
const containsTransportCredentials = (
  field: string,
  values: readonly string[],
  requestMethods: readonly string[],
): boolean => {
  if (isTransportCredentialField(field)) return true;
  if (field === "http.host" || field === "http2.headers.authority")
    return values.some((value) => value.includes("@"));
  if (field !== "http.request.uri" && field !== "http2.headers.path")
    return false;
  return values.some((value) => {
    // Request targets beginning with '/' are origin-form paths, including '//'.
    // Resolving them against a base URL would invent a network authority.
    if (value.startsWith("/")) return false;
    return (
      parseRecordedTransportUrl(value).credentials !== null ||
      // CONNECT uses authority-form; an '@' in an opaque absolute URI such as
      // mailto:alice@example.test is path data for other methods.
      (field === "http.request.uri" &&
        requestMethods.length === values.length &&
        requestMethods.every((method) => method === "CONNECT") &&
        value.split(/[/?#]/u, 1)[0]!.includes("@"))
    );
  });
};

// Fail closed for new dissector fields and alternative credential containers.
// Raw-byte selections are not admitted, even for otherwise allowed metadata.
const TLS_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "frame.number",
  "frame.time_epoch",
  "frame.len",
  "frame.cap_len",
  "frame.protocols",
  "eth.src",
  "eth.dst",
  "ip.src",
  "ip.dst",
  "ip.addr",
  "ipv6.src",
  "ipv6.dst",
  "ipv6.addr",
  "tcp.srcport",
  "tcp.dstport",
  "tcp.port",
  "tcp.stream",
  "udp.srcport",
  "udp.dstport",
  "udp.port",
  "udp.stream",
  "http.request.method",
  "http.request.uri",
  "http.host",
  "http.response.code",
  "http2.headers.method",
  "http2.headers.path",
  "http2.headers.authority",
  "http2.headers.scheme",
  "http2.headers.status",
]);
const permitsTlsFields = (input: {
  tls_key_log_path?: string | undefined;
  fields: readonly string[];
}): boolean =>
  input.tls_key_log_path === undefined ||
  (input.fields.every(
    (field) =>
      TLS_METADATA_FIELDS.has(field) || isTransportCredentialField(field),
  ) &&
    (!input.fields.includes("http.request.uri") ||
      input.fields.includes("http.request.method")));
const tlsFieldsIssue = {
  path: ["fields"],
  message:
    "With tls_key_log_path, select only reviewed packet/HTTP metadata fields listed in the packet-captures guide. Include http.request.method with http.request.uri to distinguish CONNECT authority-form. Generic headers, decoded authentication, payload/raw fields and unreviewed fields are refused.",
};
const permitsTlsFilter = (input: {
  tls_key_log_path?: string | undefined;
  display_filter: string | null;
}): boolean =>
  input.tls_key_log_path === undefined || input.display_filter === null;
const credentialFilterIssue = {
  path: ["display_filter"],
  message:
    "With tls_key_log_path, display_filter must be omitted or null; decrypted filters can probe credentials through match counts.",
};
export const inspectPacketCaptureInputSchema = captureInputShape
  .refine(withinPacketCaptureSelectorBudget, packetCaptureSelectorBudgetIssue)
  .refine(permitsTlsFields, tlsFieldsIssue)
  .refine(permitsTlsFilter, credentialFilterIssue);
export const packetCaptureOptionsSchema = captureInputShape
  .omit({ path: true })
  .refine(withinPacketCaptureSelectorBudget, packetCaptureSelectorBudgetIssue)
  .refine(permitsTlsFields, tlsFieldsIssue)
  .refine(permitsTlsFilter, credentialFilterIssue);
export type InspectPacketCaptureInput = z.infer<
  typeof inspectPacketCaptureInputSchema
>;
/** One JSON selection: an unselected key log is absent, never an undefined key. */
export const packetCaptureSelection = ({
  tls_key_log_path,
  ...selection
}: InspectPacketCaptureInput) =>
  tls_key_log_path === undefined
    ? selection
    : { ...selection, tls_key_log_path };

const frameNumberSchema = z.string().regex(/^[1-9][0-9]*$/);
/** Values remain strings; repeated occurrences remain ordered arrays. */
export const packetFieldsSchema = z
  .object({
    "frame.number": fixedTupleSchema([frameNumberSchema]),
  })
  .catchall(z.array(z.string()));
type PacketFields = z.infer<typeof packetFieldsSchema>;

const hasRequestTargetContext = (packet: PacketFields): boolean => {
  const targets = packet["http.request.uri"] ?? [];
  if (targets.length === 0) return true;
  const methods = packet["http.request.method"] ?? [];
  // Flattened field arrays cannot associate mixed CONNECT/other requests.
  // Refuse uncertain context rather than inventing userinfo in an opaque URI.
  return (
    targets.length === methods.length &&
    (methods.every((method) => method === "CONNECT") ||
      methods.every((method) => method !== "CONNECT"))
  );
};

const packetRedactionSchema = z.strictObject({
  frame: frameNumberSchema.describe("Original frame number"),
  field: z.string().describe("Selected field removed from this frame"),
  reason: z.literal("transport-credential"),
});
type PacketRedaction = z.infer<typeof packetRedactionSchema>;

/** Remove named credentials and whole URL/authority fields carrying userinfo. */
export const excludeTransportCredentialFields = (
  packets: readonly PacketFields[],
): { packets: PacketFields[]; redactions: PacketRedaction[] } => {
  const redactions: PacketRedaction[] = [];
  const retained = packets.map((packet) => {
    const frame = packet["frame.number"][0];
    return packetFieldsSchema.parse(
      Object.fromEntries(
        Object.entries(packet).filter(([field, values]) => {
          if (
            !containsTransportCredentials(
              field,
              values,
              packet["http.request.method"] ?? [],
            )
          )
            return true;
          redactions.push({ frame, field, reason: "transport-credential" });
          return false;
        }),
      ),
    );
  });
  return { packets: retained, redactions };
};

export const packetCaptureSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
    }),
    tls_key_log: tlsKeyLogReportSchema
      .exactOptional()
      .describe(
        "Present only when tls_key_log_path is selected: key-log identity and line/label counts, never its contents. Counts do not establish that any recorded session was decrypted.",
      ),
    selection: inspectPacketCaptureInputSchema,
    packets: z.array(packetFieldsSchema),
    redactions: z
      .array(packetRedactionSchema)
      .exactOptional()
      .describe(
        "Present only when tls_key_log_path is selected: known credential fields and URL/authority fields containing userinfo removed from returned frames.",
      ),
    output_window: z.strictObject({
      matching_packets: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Matches in the completed producer output within the indicated input read scope, not total capture packets",
        ),
      returned_packets: z.number().int().nonnegative(),
      has_more: z.boolean(),
    }),
    read_scope: z.enum(["to-eof", "up-to-input-packet-limit"]),
    diagnostics: z.string(),
    withheld_diagnostic_bytes: z
      .number()
      .int()
      .nonnegative()
      .exactOptional()
      .describe(
        "Present only when tls_key_log_path is selected: producer stderr bytes withheld because decrypting runs can report decrypted content; diagnostics is then empty.",
      ),
    tool: z.strictObject({
      configured_path: z.string(),
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      version_banner: z.string(),
      version_diagnostics: z.string(),
      arguments: z.array(z.string()),
    }),
    configuration: z.literal("private-empty-personal-profile"),
    resource_limiter: z.strictObject({
      configured_path: z.string(),
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      arguments: z.array(z.string()),
    }),
    limits: z.strictObject({
      input_bytes: z.number().int().positive(),
      output_bytes: z.number().int().positive(),
      command_timeout_ms: z.number().int().positive(),
      address_space_bytes: z.number().int().nonnegative(),
      file_bytes: z.number().int().nonnegative(),
      cpu_seconds: z.number().int().nonnegative(),
    }),
    hardware_acquisition: z.literal("not-performed"),
  })
  .superRefine((report, context) => {
    const remaining = Math.max(
      report.output_window.matching_packets - report.selection.match_offset,
      0,
    );
    const expected =
      report.selection.match_limit === null
        ? remaining
        : Math.min(remaining, report.selection.match_limit);
    if (
      report.packets.length !== expected ||
      report.output_window.returned_packets !== expected ||
      report.output_window.has_more !== remaining > expected
    )
      context.addIssue({
        code: "custom",
        path: ["output_window"],
        message:
          "Returned packet window must match examined matches and caller-selected offset/limit",
      });
    const keyLogPath = report.selection.tls_key_log_path;
    if (
      keyLogPath !== undefined &&
      report.packets.some(
        (packet) =>
          !hasRequestTargetContext(packet) ||
          Object.entries(packet).some(
            ([field, values]) =>
              !TLS_METADATA_FIELDS.has(field) ||
              containsTransportCredentials(
                field,
                values,
                packet["http.request.method"] ?? [],
              ),
          ),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message:
          "Decrypted packets must contain only reviewed metadata; credentials, URL userinfo and unreviewed fields must not be returned, and HTTP request targets need equal method/target counts without mixed CONNECT/other methods.",
      });
    if (
      (keyLogPath === undefined) !== (report.tls_key_log === undefined) ||
      (keyLogPath === undefined) !== (report.redactions === undefined) ||
      (keyLogPath === undefined) !==
        (report.withheld_diagnostic_bytes === undefined) ||
      (keyLogPath !== undefined && report.diagnostics !== "") ||
      (report.tls_key_log !== undefined &&
        report.tls_key_log.path !== keyLogPath)
    )
      context.addIssue({
        code: "custom",
        path: ["tls_key_log"],
        message:
          "Key-log identity, redactions and withheld diagnostics are reported exactly when tls_key_log_path is selected",
      });
    const returned = new Map(
      report.packets.map((packet) => [packet["frame.number"][0], packet]),
    );
    for (const redaction of report.redactions ?? []) {
      const packet = returned.get(redaction.frame);
      if (
        packet === undefined ||
        Object.hasOwn(packet, redaction.field) ||
        !report.selection.fields.includes(redaction.field)
      )
        context.addIssue({
          code: "custom",
          path: ["redactions"],
          message:
            "A redaction must name a selected field absent from a returned frame",
        });
    }
  });
