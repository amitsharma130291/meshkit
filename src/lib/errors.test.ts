import { describe, expect, it } from "vitest";
import { createSafeError } from "./errors";

describe("createSafeError", () => {
  it("returns a stable, safe message for a known code", () => {
    const error = createSafeError("WORKER_CRASHED");
    expect(error.code).toBe("WORKER_CRASHED");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("marks known-recoverable codes as recoverable and others as not", () => {
    expect(createSafeError("PROCESS_CANCELLED").recoverable).toBe(true);
    expect(createSafeError("WASM_COMPILE_FAILED").recoverable).toBe(false);
  });

  it("allows a safe, pre-approved detail message to override the default", () => {
    const error = createSafeError("UNSUPPORTED_FORMAT", "Supported formats: STL, OBJ.");
    expect(error.message).toBe("Supported formats: STL, OBJ.");
  });
});
