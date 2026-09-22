import { describe, expect, it } from "vitest";
import { createRequestId, isWorkerResponse } from "./protocol";

describe("createRequestId", () => {
  it("creates unique ids across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createRequestId()));
    expect(ids.size).toBe(20);
  });
});

describe("isWorkerResponse", () => {
  it("accepts every valid response shape", () => {
    expect(isWorkerResponse({ type: "ready", requestId: "1" })).toBe(true);
    expect(isWorkerResponse({ type: "cancelled", requestId: "1" })).toBe(true);
    expect(isWorkerResponse({ type: "progress", requestId: "1", stage: "reading", completed: 0 })).toBe(true);
    expect(isWorkerResponse({ type: "result", requestId: "1", result: { ok: true } })).toBe(true);
    expect(
      isWorkerResponse({
        type: "error",
        requestId: "1",
        code: "UNKNOWN_ERROR",
        message: "oops",
        recoverable: false,
      }),
    ).toBe(true);
  });

  it("rejects malformed or unrelated values", () => {
    expect(isWorkerResponse({ type: "result" })).toBe(false); // missing requestId
    expect(isWorkerResponse({ type: "progress", requestId: "1" })).toBe(false); // missing stage/completed
    expect(isWorkerResponse({ type: "unknown-type", requestId: "1" })).toBe(false);
    expect(isWorkerResponse(null)).toBe(false);
    expect(isWorkerResponse("not an object")).toBe(false);
  });
});
