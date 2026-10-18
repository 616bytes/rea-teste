import { expect, it } from "vitest";
import {
  excludeTransportCredentialFields,
  inspectPacketCaptureInputSchema,
  packetCaptureSchema,
} from "./packetCapture.js";

const tool = {
  configured_path: "/usr/bin/tshark",
  path: "/usr/bin/tshark",
  sha256: "1".repeat(64),
  version_banner: "TShark (Wireshark) 4.6.9\n",
  version_diagnostics: "",
  arguments: ["-n"],
};
const report = (selection: Record<string, unknown>, extra = {}) => ({
  artifact: { path: "/captures/a.pcapng", sha256: "2".repeat(64), bytes: 10 },
  selection: inspectPacketCaptureInputSchema.parse(selection),
  packets: [{ "frame.number": ["4"], "http2.headers.path": ["/v1/items"] }],
  output_window: { matching_packets: 1, returned_packets: 1, has_more: false },
  read_scope: "to-eof",
  diagnostics: "",
  tool,
  configuration: "private-empty-personal-profile",
  resource_limiter: {
    configured_path: "/usr/bin/prlimit",
    path: "/usr/bin/prlimit",
    sha256: "4".repeat(64),
    arguments: [],
  },
  limits: {
    input_bytes: 1,
    output_bytes: 1,
    command_timeout_ms: 1,
    address_space_bytes: 0,
    file_bytes: 0,
    cpu_seconds: 0,
  },
  hardware_acquisition: "not-performed",
  ...extra,
});
const keyLog = {
  path: "/captures/client.keys",
  sha256: "3".repeat(64),
  bytes: 0,
  lines: { total: 0, comment_or_blank: 0, unrecognized: 0 },
  labels: {
    CLIENT_RANDOM: 0,
    CLIENT_EARLY_TRAFFIC_SECRET: 0,
    CLIENT_HANDSHAKE_TRAFFIC_SECRET: 0,
    SERVER_HANDSHAKE_TRAFFIC_SECRET: 0,
    CLIENT_TRAFFIC_SECRET_0: 0,
    SERVER_TRAFFIC_SECRET_0: 0,
    EARLY_EXPORTER_SECRET: 0,
    EXPORTER_SECRET: 0,
  },
  client_randoms: { in_key_log: 0 },
  secret_values: "not-returned",
};

it("removes known transport-credential fields per frame and records each removal", () => {
  const packets = [
    {
      "frame.number": ["4"] as [string],
      "http2.headers.path": ["/v1/items"],
      "http2.headers.authorization": ["Bearer fixture-token"],
      "http.cookie": ["session=fixture"],
    },
    { "frame.number": ["9"] as [string], "http2.headers.status": ["200"] },
    {
      "frame.number": ["12"] as [string],
      "@http3.headers.set_cookie": ["7365743d31"],
      "http.authbasic": ["user:password"],
      "http.request.uri": ["/login"],
    },
  ];
  expect(excludeTransportCredentialFields(packets)).toEqual({
    packets: [
      { "frame.number": ["4"], "http2.headers.path": ["/v1/items"] },
      { "frame.number": ["9"], "http2.headers.status": ["200"] },
      { "frame.number": ["12"], "http.request.uri": ["/login"] },
    ],
    redactions: [
      {
        frame: "4",
        field: "http2.headers.authorization",
        reason: "transport-credential",
      },
      { frame: "4", field: "http.cookie", reason: "transport-credential" },
      {
        frame: "12",
        field: "@http3.headers.set_cookie",
        reason: "transport-credential",
      },
      { frame: "12", field: "http.authbasic", reason: "transport-credential" },
    ],
  });
  expect(packets[0]).toHaveProperty("http.cookie");
});

it("keeps the existing report shape unless a key log was selected", () => {
  const plain = report({ path: "/captures/a.pcapng", fields: ["x"] });
  const parsed = packetCaptureSchema.parse(plain);
  expect(Object.keys(parsed)).not.toContain("tls_key_log");
  expect(Object.keys(parsed)).not.toContain("redactions");
  expect(Object.keys(parsed.selection)).not.toContain("tls_key_log_path");
  for (const extra of [
    { tls_key_log: keyLog },
    { redactions: [] },
    { tls_key_log: keyLog, redactions: [] },
    { withheld_diagnostic_bytes: 0 },
  ])
    expect(packetCaptureSchema.safeParse({ ...plain, ...extra }).success).toBe(
      false,
    );
});

it("binds key-log identity and redactions to the selected key log and returned frames", () => {
  const selection = {
    path: "/captures/a.pcapng",
    fields: ["http2.headers.path", "http2.headers.authorization"],
    tls_key_log_path: "/captures/client.keys",
  };
  const redaction = {
    frame: "4",
    field: "http2.headers.authorization",
    reason: "transport-credential",
  };
  const valid = report(selection, {
    tls_key_log: keyLog,
    redactions: [redaction],
    withheld_diagnostic_bytes: 17,
  });
  expect(packetCaptureSchema.parse(valid)).toMatchObject({
    tls_key_log: keyLog,
    redactions: [redaction],
    diagnostics: "",
    withheld_diagnostic_bytes: 17,
  });
  const unreported = report(selection, {
    tls_key_log: keyLog,
    redactions: [redaction],
  });
  expect(packetCaptureSchema.safeParse(unreported).success).toBe(false);
  expect(
    packetCaptureSchema.safeParse({ ...valid, diagnostics: "stderr text" })
      .success,
  ).toBe(false);
  for (const extra of [
    { tls_key_log: keyLog },
    { redactions: [] },
    { tls_key_log: { ...keyLog, path: "/other.keys" }, redactions: [] },
    { tls_key_log: keyLog, redactions: [{ ...redaction, frame: "5" }] },
    {
      tls_key_log: keyLog,
      redactions: [{ ...redaction, field: "http.cookie" }],
    },
    {
      tls_key_log: keyLog,
      redactions: [{ ...redaction, field: "http2.headers.path" }],
    },
  ])
    expect(
      packetCaptureSchema.safeParse({
        ...report(selection),
        withheld_diagnostic_bytes: 17,
        ...extra,
      }).success,
    ).toBe(false);
});

it.each(["http2.header.value", "http.authorization", "future.decrypted.field"])(
  "refuses a key-log report containing unapproved returned field %s",
  (field) => {
    const malformed = report(
      {
        path: "/captures/a.pcapng",
        fields: ["http2.headers.path", "http.authorization"],
        tls_key_log_path: "/captures/client.keys",
      },
      {
        tls_key_log: keyLog,
        redactions: [],
        withheld_diagnostic_bytes: 0,
        packets: [
          {
            "frame.number": ["4"],
            "http2.headers.path": ["/v1/items"],
            [field]: ["Bearer fixture-credential"],
          },
        ],
      },
    );
    expect(packetCaptureSchema.safeParse(malformed).success).toBe(false);
  },
);

it.each([
  [
    "http.request.uri",
    "https://alice:fixture-password@example.test/path",
    "GET",
  ],
  ["http.request.uri", "alice:fixture-password@example.test:443", "CONNECT"],
  ["http.request.uri", "https:\\\\alice:fixture-password@example.test/path"],
  ["http.request.uri", "https://ali\tce:fixture-password@example.test/path"],
  ["http.request.uri", "https://alice:fixture-password@[invalid/path"],
  ["http2.headers.path", "https://alice:fixture-password@example.test/path"],
  ["http.host", "alice:fixture-password@example.test"],
  ["http2.headers.authority", "alice:fixture-password@example.test:443"],
])(
  "excludes structural URL userinfo from %s (%s)",
  (field, value, method = "GET") => {
    const packets = [
      {
        "frame.number": ["4"] as [string],
        "http.request.method": [method, method],
        [field]: ["safe-first-value", value],
      },
    ];
    const redacted = excludeTransportCredentialFields(packets);
    expect(packets[0]?.[field]).toContain(value);
    const selected = {
      path: "/captures/a.pcapng",
      fields: ["http.request.method", field],
      tls_key_log_path: keyLog.path,
    };
    const unredacted = report(selected, {
      tls_key_log: keyLog,
      withheld_diagnostic_bytes: 0,
      redactions: [],
      packets,
    });
    const invalid = packetCaptureSchema.safeParse(unredacted);
    expect(invalid.success).toBe(false);
    expect(redacted).toEqual({
      packets: [
        { "frame.number": ["4"], "http.request.method": [method, method] },
      ],
      redactions: [{ frame: "4", field, reason: "transport-credential" }],
    });
    if (!invalid.success)
      expect(JSON.stringify(invalid.error.issues)).not.toContain(
        "fixture-password",
      );
    expect(
      packetCaptureSchema.safeParse({ ...unredacted, ...redacted }).success,
    ).toBe(true);
  },
);

it("preserves origin-form paths, queries and URL path data without guessing secrecy", () => {
  const packets = [
    {
      "frame.number": ["4"] as [string],
      "http.request.method": ["GET"],
      "http.request.uri": [
        "/users/alice@example.test?next=https://user:password@example.test",
        "//alice:password@example.test/path",
        "https://example.test/path@segment?password=application-data",
        "https://example.test\\user:password@path",
        "mailto:alice@example.test",
        "urn:example:alice@example.test",
      ],
      "http2.headers.path": ["/@name", "//user:password@example.test", "*"],
      "http.host": ["example.test", "[::1]:443"],
      "http2.headers.authority": ["example.test:443"],
    },
  ];
  expect(excludeTransportCredentialFields(packets)).toEqual({
    packets,
    redactions: [],
  });
});

it.each([
  { methods: [], targets: ["/ordinary-target"] },
  {
    methods: ["CONNECT"],
    targets: ["mailto:alice@example.test", "example.test:443"],
  },
  {
    methods: ["GET", "CONNECT"],
    targets: ["mailto:alice@example.test", "example.test:443"],
  },
])(
  "refuses uncertain request-target context without inventing credential removals: %j",
  ({ methods, targets }) => {
    const packets = [
      {
        "frame.number": ["4"] as [string],
        "http.request.uri": targets,
        "http.request.method": methods,
      },
    ];
    expect(excludeTransportCredentialFields(packets)).toEqual({
      packets,
      redactions: [],
    });
    const malformed = report(
      {
        path: "/captures/a.pcapng",
        fields: ["http.request.uri", "http.request.method"],
        tls_key_log_path: keyLog.path,
      },
      {
        tls_key_log: keyLog,
        withheld_diagnostic_bytes: 0,
        redactions: [],
        packets,
      },
    );
    expect(packetCaptureSchema.safeParse(malformed).success).toBe(false);
  },
);
