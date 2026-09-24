import { describe, expect, it } from "vitest";
import { batchError, BatchException, toBatchSafeError } from "./errors";

describe("BatchException / batchError", () => {
  it("carries its own error code", () => {
    const err = batchError("BATCH_QUEUE_FULL");
    expect(err).toBeInstanceOf(BatchException);
    expect(err.code).toBe("BATCH_QUEUE_FULL");
    expect(err.name).toBe("BatchException");
  });
});

describe("toBatchSafeError", () => {
  it("translates a BatchException into a SafeError with its own code and message", () => {
    const safe = toBatchSafeError(batchError("BATCH_FILE_TOO_LARGE"));
    expect(safe.code).toBe("BATCH_FILE_TOO_LARGE");
    expect(safe.message).toContain("larger");
    expect(typeof safe.recoverable).toBe("boolean");
  });

  it("falls back to UNKNOWN_ERROR for an unrelated error", () => {
    const safe = toBatchSafeError(new Error("some other failure"));
    expect(safe.code).toBe("UNKNOWN_ERROR");
  });

  it("never leaks the original error's message text", () => {
    const safe = toBatchSafeError(new Error("/Users/amits/secret/path leaked here"));
    expect(safe.message).not.toContain("secret");
    expect(safe.message).not.toContain("/Users/");
  });
});
