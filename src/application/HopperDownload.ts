/** Maximum admitted vendor response bytes, shared by Hopper setup adapters. */
export const HOPPER_DOWNLOAD_BYTES = 100_000_000;

/** Abort only when the vendor stops delivering bytes; slow links may need far longer in total. */
const HOPPER_DOWNLOAD_IDLE_MS = 120_000;

/** Bound observed response bytes before retaining them, including chunked bodies. */
export const downloadHopperPackage = async (
  url: string,
  options: {
    readonly signal?: AbortSignal;
    readonly idleTimeoutMs?: number;
  } = {},
): Promise<{ readonly ok: boolean; readonly bytes: Uint8Array }> => {
  const idleTimeoutMs = options.idleTimeoutMs ?? HOPPER_DOWNLOAD_IDLE_MS;
  const idle = new AbortController();
  const stalled = (): void => {
    idle.abort(
      new DOMException(
        `Hopper download received no bytes for ${String(idleTimeoutMs)} ms`,
        "TimeoutError",
      ),
    );
  };
  let timer = setTimeout(stalled, idleTimeoutMs);
  const progressed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(stalled, idleTimeoutMs);
  };
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "rea-installer" },
      signal:
        options.signal === undefined
          ? idle.signal
          : AbortSignal.any([options.signal, idle.signal]),
    });
    progressed();
    const refused = { ok: false, bytes: new Uint8Array() };
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > HOPPER_DOWNLOAD_BYTES
    ) {
      await response.body?.cancel();
      return refused;
    }
    if (response.body === null) return { ok: true, bytes: new Uint8Array() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          return { ok: true, bytes: Buffer.concat(chunks, bytes) };
        progressed();
        if (chunk.value.byteLength > HOPPER_DOWNLOAD_BYTES - bytes) {
          await reader.cancel();
          return refused;
        }
        chunks.push(chunk.value);
        bytes += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
  }
};
