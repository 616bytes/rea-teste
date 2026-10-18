import { isAbsolute } from "node:path";
import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";
import { PacketCaptureService } from "./PacketCaptureService.js";

const absolute = (name: string): string =>
  process.platform === "win32" ? `C:\\captures\\${name}` : `/captures/${name}`;

const recordingService = () => {
  const inputs: unknown[] = [];
  const service = new PacketCaptureService({
    inspect: async (input) => {
      inputs.push(input);
      return err(new AnalysisCancelledError("inspect_packet_capture"));
    },
    inspectFields: async () => {
      throw new Error("Unexpected field discovery call");
    },
    close: async () => {},
  });
  return { service, inputs };
};

it("rejects a relative TLS key log before provider work", async () => {
  const { service, inputs } = recordingService();
  for (const tls_key_log_path of ["client.keys", "", "a\0b"]) {
    const result = await service.inspect({
      path: absolute("a.pcapng"),
      fields: ["http2.headers.path"],
      tls_key_log_path,
    });
    if (result.ok) throw new Error("Expected key-log input refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["tls_key_log_path"] })],
    });
  }
  expect(inputs).toEqual([]);
});

it("passes an absolute key log to the provider and omits it when not selected", async () => {
  const { service, inputs } = recordingService();
  const keyLog = absolute("client.keys");
  expect(isAbsolute(keyLog)).toBe(true);
  await service.inspect({
    path: absolute("a.pcapng"),
    fields: ["http2.headers.path"],
    tls_key_log_path: keyLog,
  });
  await service.inspect({
    path: absolute("a.pcapng"),
    fields: ["http2.headers.path"],
  });
  // An in-process caller's explicit undefined is normalized to absence.
  await service.inspect({
    path: absolute("a.pcapng"),
    fields: ["http2.headers.path"],
    tls_key_log_path: undefined,
  });
  expect(inputs).toEqual([
    expect.objectContaining({ tls_key_log_path: keyLog }),
    expect.not.objectContaining({ tls_key_log_path: expect.anything() }),
    expect.not.objectContaining({ tls_key_log_path: expect.anything() }),
  ]);
  expect(Object.keys(inputs[1] ?? {})).not.toContain("tls_key_log_path");
  expect(Object.keys(inputs[2] ?? {})).not.toContain("tls_key_log_path");
});

it("refuses every display filter when a key log is selected", async () => {
  const { service, inputs } = recordingService();
  const base = {
    path: absolute("a.pcapng"),
    fields: ["http2.headers.path"],
  };
  for (const display_filter of [
    'http.cookie contains "sess=a"',
    'HTTP2.HEADERS.AUTHORIZATION matches "^Bearer"',
    'http3.headers.set_cookie == "x" || tcp',
    'frame contains "http.authorization"',
    'http2.header.value matches "^Bearer A"',
    'http contains "Cookie"',
    'tcp.payload contains "session="',
    "http2.headers.path",
    "ip.addr == 192.0.2.1",
    "${credential_probe}",
  ]) {
    const result = await service.inspect({
      ...base,
      display_filter,
      tls_key_log_path: absolute("client.keys"),
    });
    if (result.ok) throw new Error("Expected credential filter refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["display_filter"] })],
    });
  }
  expect(inputs).toEqual([]);
  await service.inspect({
    ...base,
    display_filter: 'http.cookie contains "sess=a"',
  });
  await service.inspect({
    ...base,
    display_filter: "http2.headers.path",
  });
  expect(inputs).toHaveLength(2);
});

it.each([
  "http.request.line",
  "http.response.line",
  "http2.header.value",
  "http2.header.name",
  "http3.header.value",
  "ntlmssp.auth.username",
  "kerberos.CNameString",
  "data.data",
  "tcp.payload",
  "tls.app_data",
  "ip.payload",
  "@http2.headers.path",
  "future.new.decrypted.field",
])(
  "refuses unreviewed decrypted field %s before provider work",
  async (field) => {
    const { service, inputs } = recordingService();
    const base = {
      path: absolute("a.pcapng"),
      fields: ["http2.headers.path", field],
    };
    const result = await service.inspect({
      ...base,
      tls_key_log_path: absolute("client.keys"),
    });
    if (result.ok) throw new Error("Expected decrypted field refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["fields"] })],
    });
    expect(inputs).toEqual([]);
    await service.inspect(base);
    expect(inputs).toHaveLength(1);
  },
);

it("admits reviewed metadata and removable named credentials with a key log", async () => {
  const { service, inputs } = recordingService();
  const fields = [
    "frame.number",
    "ip.addr",
    "http.request.uri",
    "http.request.method",
    "http2.headers.path",
    "http.authorization",
    "@http.cookie",
  ];
  await service.inspect({
    path: absolute("a.pcapng"),
    fields,
    tls_key_log_path: absolute("client.keys"),
  });
  expect(inputs).toEqual([expect.objectContaining({ fields })]);
});

it("requires the HTTP method with a decrypted request target to distinguish CONNECT authority", async () => {
  const { service, inputs } = recordingService();
  const result = await service.inspect({
    path: absolute("a.pcapng"),
    fields: ["http.request.uri"],
    tls_key_log_path: absolute("client.keys"),
  });
  if (result.ok) throw new Error("Expected request-target context refusal");
  expect(result.error).toMatchObject({
    _tag: "AnalysisInputError",
    issues: [expect.objectContaining({ path: ["fields"] })],
  });
  expect(inputs).toEqual([]);
});
