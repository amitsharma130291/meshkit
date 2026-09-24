import { describe, expect, it } from "vitest";
import { ResultStore, type ObjectUrlFactory } from "./result-store";

function fakeUrlFactory(): ObjectUrlFactory & { created: Blob[]; revoked: string[] } {
  let counter = 0;
  const created: Blob[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    createObjectURL(blob: Blob) {
      created.push(blob);
      counter++;
      return `blob:fake-${counter}`;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
}

describe("ResultStore — creating and caching object URLs", () => {
  it("creates an object URL for a job's output bytes", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    const url = store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    expect(url).toBe("blob:fake-1");
    expect(factory.created).toHaveLength(1);
  });

  it("reuses the cached URL for the same job rather than creating a new blob each time", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    const first = store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    const second = store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    expect(first).toBe(second);
    expect(factory.created).toHaveLength(1);
  });
});

describe("ResultStore — revocation triggers", () => {
  it("revoke(jobId) — a job is removed", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    const url = store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    store.revoke("job-1");
    expect(factory.revoked).toEqual([url]);
    expect(store.getUrl("job-1")).toBeNull();
  });

  it("revoking an id with no stored URL is a safe no-op", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    expect(() => store.revoke("never-created")).not.toThrow();
    expect(factory.revoked).toEqual([]);
  });

  it("revokeAll() — results are cleared / a batch is replaced", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    store.getOrCreateUrl("job-2", new ArrayBuffer(4), "model/stl");
    store.revokeAll();
    expect(factory.revoked).toHaveLength(2);
    expect(store.getUrl("job-1")).toBeNull();
    expect(store.getUrl("job-2")).toBeNull();
  });

  it("dispose() revokes everything — page unload / entitlement unavailable", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    store.dispose();
    expect(factory.revoked).toHaveLength(1);
  });

  it("after dispose, getOrCreateUrl is a safe no-op that creates nothing further", () => {
    const factory = fakeUrlFactory();
    const store = new ResultStore(factory);
    store.dispose();
    const url = store.getOrCreateUrl("job-1", new ArrayBuffer(4), "model/stl");
    expect(url).toBeNull();
    expect(factory.created).toHaveLength(0);
  });
});

describe("ResultStore — getUrl without creating", () => {
  it("returns null when no URL has been created for that job yet", () => {
    const store = new ResultStore(fakeUrlFactory());
    expect(store.getUrl("job-1")).toBeNull();
  });
});
