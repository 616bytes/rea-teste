import { describe, expect, it } from "vitest";

import { downloadHopperPackage, servedOverHttps } from "./HopperDownload.js";

const VENDOR = "https://www.hopperapp.com/downloader/public/Hopper.deb";

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

/** Serve scripted responses and record every URL actually requested. */
const scriptedFetch = (responses: readonly Response[]) => {
  const requested: string[] = [];
  const pending = [...responses];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    expect(init?.redirect).toBe("manual");
    const next = pending.shift();
    if (next === undefined) throw new Error("unexpected request");
    return Promise.resolve(next);
  }) as typeof fetch;
  return { fetchImpl, requested };
};

describe("servedOverHttps", () => {
  it("admits HTTPS and refuses other schemes or malformed URLs", () => {
    expect(servedOverHttps(VENDOR)).toBe(true);
    for (const url of [
      "http://www.hopperapp.com/downloader/public/Hopper.deb",
      "ftp://example.test/Hopper.deb",
      "",
      "not a url",
    ])
      expect(servedOverHttps(url)).toBe(false);
  });
});

describe("downloadHopperPackage", () => {
  it("follows HTTPS redirects and returns the final body", async () => {
    const { fetchImpl, requested } = scriptedFetch([
      redirect("https://cdn.example.test/Hopper.deb"),
      new Response("package"),
    ]);
    const result = await downloadHopperPackage(VENDOR, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toBe("package");
    expect(requested).toEqual([VENDOR, "https://cdn.example.test/Hopper.deb"]);
  });

  it("refuses an HTTP hop before requesting it, even if it would return to HTTPS", async () => {
    const { fetchImpl, requested } = scriptedFetch([
      redirect("http://www.hopperapp.com/downloader/public/Hopper.deb"),
      redirect("https://attacker.example.test/Hopper.deb"),
      new Response("replaced"),
    ]);
    const result = await downloadHopperPackage(VENDOR, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(requested).toEqual([VENDOR]);
  });

  it("refuses redirects without a Location and redirect chains past the budget", async () => {
    const missing = scriptedFetch([new Response(null, { status: 302 })]);
    expect(
      (await downloadHopperPackage(VENDOR, { fetch: missing.fetchImpl })).ok,
    ).toBe(false);
    const loop = scriptedFetch(
      Array.from({ length: 6 }, () => redirect(VENDOR)),
    );
    expect(
      (await downloadHopperPackage(VENDOR, { fetch: loop.fetchImpl })).ok,
    ).toBe(false);
    expect(loop.requested).toHaveLength(6);
  });
});
