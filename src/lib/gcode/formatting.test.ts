import { describe, expect, it } from "vitest";
import { formatDurationSeconds, formatDistanceMm, formatGCodeStatus } from "./formatting";

describe("formatDurationSeconds", () => {
  it("formats seconds only under a minute", () => {
    expect(formatDurationSeconds(45)).toBe("45s");
  });

  it("formats minutes and seconds under an hour", () => {
    expect(formatDurationSeconds(750)).toBe("12m 30s");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatDurationSeconds(3723)).toBe("1h 2m 3s");
  });

  it("never returns a negative duration", () => {
    expect(formatDurationSeconds(-10)).toBe("0s");
  });
});

describe("formatDistanceMm", () => {
  it("shows millimeters below 1000mm", () => {
    expect(formatDistanceMm(452.3)).toBe("452.3 mm");
  });

  it("shows meters at or above 1000mm", () => {
    expect(formatDistanceMm(2500)).toBe("2.50 m");
  });
});

describe("formatGCodeStatus", () => {
  it("has a label for every status", () => {
    expect(formatGCodeStatus("ready")).toBe("Ready");
    expect(formatGCodeStatus("ready-with-warnings")).toBe("Ready, with warnings");
  });
});
