import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionEntitlementProvider } from "./production-provider";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function stubBrowser(storage: Storage, fetchImpl: typeof fetch): void {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("fetch", fetchImpl);
}

async function waitForSnapshot(
  provider: ReturnType<typeof createProductionEntitlementProvider>,
  predicate: (snapshot: ReturnType<typeof provider.getSnapshot>) => boolean,
): Promise<void> {
  for (let i = 0; i < 50 && !predicate(provider.getSnapshot()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("createProductionEntitlementProvider — no stored license key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves free without ever calling the network", async () => {
    const fetchSpy = vi.fn();
    stubBrowser(fakeStorage(), fetchSpy as unknown as typeof fetch);
    const provider = createProductionEntitlementProvider();
    await waitForSnapshot(provider, (s) => s.status !== "unavailable");
    expect(provider.getSnapshot().status).toBe("free");
    expect(provider.getSnapshot().capabilities.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("the synchronous initial snapshot (before any async check settles) is never pro", () => {
    stubBrowser(fakeStorage(), vi.fn() as unknown as typeof fetch);
    const provider = createProductionEntitlementProvider();
    expect(provider.getSnapshot().status).not.toBe("pro");
    provider.dispose();
  });
});

describe("createProductionEntitlementProvider — stored license key, server verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves pro with the full capability set when the server confirms the key is valid", async () => {
    const storage = fakeStorage({
      "meshwrench.pro.license-key.v1": "PRO-AAAA-BBBB-CCCC-DDDD",
      "meshwrench.pro.license-instance-id.v1": "instance_1",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
    stubBrowser(storage, fetchImpl as unknown as typeof fetch);

    const provider = createProductionEntitlementProvider();
    await waitForSnapshot(provider, (s) => s.status === "pro");
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).toBe("pro");
    expect(snapshot.capabilities.size).toBeGreaterThan(0);
    expect(snapshot.source).toBe("license-key");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/license/verify",
      expect.objectContaining({ method: "POST" }),
    );
    provider.dispose();
  });

  it("never resolves pro when the server says the key is invalid", async () => {
    const storage = fakeStorage({
      "meshwrench.pro.license-key.v1": "PRO-EXPIRED",
      "meshwrench.pro.license-instance-id.v1": "instance_1",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: false }), { status: 200 }));
    stubBrowser(storage, fetchImpl as unknown as typeof fetch);

    const provider = createProductionEntitlementProvider();
    await waitForSnapshot(provider, (s) => s.status !== "unavailable");
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).not.toBe("pro");
    expect(snapshot.capabilities.size).toBe(0);
    provider.dispose();
  });

  it("fails closed (never pro) when the verification network call throws", async () => {
    const storage = fakeStorage({
      "meshwrench.pro.license-key.v1": "PRO-AAAA",
      "meshwrench.pro.license-instance-id.v1": "instance_1",
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    stubBrowser(storage, fetchImpl as unknown as typeof fetch);

    const provider = createProductionEntitlementProvider();
    await waitForSnapshot(provider, (s) => s.status !== "unavailable" || s.checkedAt !== null);
    expect(provider.getSnapshot().status).not.toBe("pro");
    provider.dispose();
  });

  it("fails closed (never pro) when the server responds with a non-OK HTTP status", async () => {
    const storage = fakeStorage({
      "meshwrench.pro.license-key.v1": "PRO-AAAA",
      "meshwrench.pro.license-instance-id.v1": "instance_1",
    });
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }));
    stubBrowser(storage, fetchImpl as unknown as typeof fetch);

    const provider = createProductionEntitlementProvider();
    await waitForSnapshot(provider, (s) => s.checkedAt !== null);
    expect(provider.getSnapshot().status).not.toBe("pro");
    provider.dispose();
  });
});

describe("createProductionEntitlementProvider — no bypass mechanisms (source-level guarantee)", () => {
  const rawSource = readFileSync(new URL("./production-provider.ts", import.meta.url), "utf8");
  // Strip comments first so prose explaining WHY these are forbidden
  // (which necessarily names them) doesn't trip the check meant for CODE.
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("never imports the test provider", () => {
    expect(source).not.toContain("test-provider");
  });

  it("never resolves a snapshot to \"pro\" without going through the /api/license/verify server call", () => {
    // Every occurrence of the literal "pro" status string must appear
    // strictly after the fetch call to the verify endpoint in source
    // order — i.e. there is no synchronous createSnapshot("pro", ...)
    // anywhere before the network round-trip.
    const verifyCallIndex = source.indexOf('"/api/license/verify"');
    expect(verifyCallIndex).toBeGreaterThan(-1);
    const proStatusIndex = source.indexOf('"pro"');
    expect(proStatusIndex).toBeGreaterThan(verifyCallIndex);
  });

  it("never reads a query string, hash, or global unlock flag", () => {
    for (const token of ["location.search", "URLSearchParams", "location.hash", "devPro"]) {
      expect(source).not.toContain(token);
    }
  });
});
