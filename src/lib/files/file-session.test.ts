import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSession } from "./file-session";

function fakeFile(): File {
  return {
    name: "model.stl",
    size: 10,
    arrayBuffer: vi.fn(async () => new ArrayBuffer(10)),
  } as unknown as File;
}

function stubUrl() {
  const createObjectURL = vi.fn(() => "blob:mock-url");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileSession", () => {
  it("revokes created object URLs on dispose", () => {
    const { revokeObjectURL } = stubUrl();
    const session = new FileSession(fakeFile(), "stl");

    const url = session.createObjectUrl();
    expect(url).toBe("blob:mock-url");

    session.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("runs registered cleanup callbacks exactly once, even if dispose is called twice", () => {
    stubUrl();
    const session = new FileSession(fakeFile(), "stl");
    const cleanup = vi.fn();
    session.registerCleanup(cleanup);

    session.dispose();
    session.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("throws when used after disposal", () => {
    stubUrl();
    const session = new FileSession(fakeFile(), "stl");
    session.dispose();
    expect(() => session.createObjectUrl()).toThrow();
  });
});
