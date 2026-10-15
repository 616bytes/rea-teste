/** Maximum admitted vendor response bytes, shared by Hopper setup adapters. */
export const HOPPER_DOWNLOAD_BYTES = 100_000_000;

/** Whether a URL uses HTTPS; malformed URLs are refused. */
export const servedOverHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Follow redirects one hop at a time. Automatic following would request a
 * plain-HTTP hop before any check could run, and a network attacker could
 * then redirect onward to an HTTPS host they control. Returns undefined when
 * any hop leaves HTTPS, lacks a usable Location, or exceeds the hop budget.
 */
const fetchOverHttpsOnly = async (
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response | undefined> => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!servedOverHttps(current)) return undefined;
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null) return undefined;
    try {
      current = new URL(location, current).href;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Bound observed response bytes before retaining them, including chunked bodies. */
export const downloadHopperPackage = async (
  url: string,
  options: {
    readonly signal?: AbortSignal;
    readonly fetch?: typeof fetch;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<{ readonly ok: boolean; readonly bytes: Uint8Array }> => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("Invalid Hopper response time budget");
  const deadline = AbortSignal.timeout(timeoutMs);
  const maxBytes = options.maxBytes ?? HOPPER_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HOPPER_DOWNLOAD_BYTES
  )
    throw new RangeError("Invalid Hopper response byte budget");
  const response = await fetchOverHttpsOnly(
    url,
    {
      headers: { accept: "application/json", "user-agent": "rea-installer" },
      signal:
        options.signal === undefined
          ? deadline
          : AbortSignal.any([options.signal, deadline]),
    },
    options.fetch ?? fetch,
  );
  const refused = { ok: false, bytes: new Uint8Array() };
  if (response === undefined) return refused;
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > maxBytes
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
      if (chunk.done) return { ok: true, bytes: Buffer.concat(chunks, bytes) };
      if (chunk.value.byteLength > maxBytes - bytes) {
        await reader.cancel();
        return refused;
      }
      chunks.push(chunk.value);
      bytes += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
};
