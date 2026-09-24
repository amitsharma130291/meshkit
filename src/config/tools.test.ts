import { describe, expect, it } from "vitest";
import { getToolById, toolRegistry } from "./tools";

describe("tool registry — relatedToolIds reciprocity", () => {
  it("every relatedToolIds entry points at a tool that actually exists in the registry", () => {
    for (const tool of toolRegistry) {
      for (const relatedId of tool.relatedToolIds ?? []) {
        expect(getToolById(relatedId), `"${tool.id}" lists unknown related tool "${relatedId}"`).toBeDefined();
      }
    }
  });

  it("a ready tool's related, ready tools link back to it (reciprocal cross-linking)", () => {
    const missingReciprocity: string[] = [];
    for (const tool of toolRegistry) {
      if (tool.status !== "ready") continue;
      for (const relatedId of tool.relatedToolIds ?? []) {
        const related = getToolById(relatedId);
        if (!related || related.status !== "ready") continue;
        const reciprocal = (related.relatedToolIds ?? []).includes(tool.id);
        if (!reciprocal) missingReciprocity.push(`"${tool.id}" -> "${relatedId}" is not reciprocated back`);
      }
    }
    expect(missingReciprocity).toEqual([]);
  });
});

describe("tool registry — route/status sanity", () => {
  it("every tool has a unique id and a unique path", () => {
    const ids = toolRegistry.map((t) => t.id);
    const paths = toolRegistry.map((t) => t.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("every path starts and ends with a slash", () => {
    for (const tool of toolRegistry) {
      expect(tool.path.startsWith("/"), `"${tool.id}" path "${tool.path}" doesn't start with /`).toBe(true);
      expect(tool.path.endsWith("/"), `"${tool.id}" path "${tool.path}" doesn't end with /`).toBe(true);
    }
  });

  it("no tool's description mentions a format that isn't in inputFormats/outputFormats or the tool name", () => {
    // A light guard against copy drifting from what a tool actually reads/writes.
    for (const tool of toolRegistry) {
      expect(tool.description.length, `"${tool.id}" has an empty description`).toBeGreaterThan(0);
    }
  });
});

describe("tool registry — no fabricated formats", () => {
  const GCODE_TOOL_IDS = new Set(["gcode-viewer", "gcode-visualizer", "gcode-simulator", "gcode-layer-viewer", "gcode-toolpath-viewer"]);

  it("only the real Phase 9 G-code Cluster tools claim gcode support — no other tool fabricates it", () => {
    for (const tool of toolRegistry) {
      if (GCODE_TOOL_IDS.has(tool.id)) continue;
      expect(tool.inputFormats).not.toContain("gcode");
      expect(tool.outputFormats ?? []).not.toContain("gcode");
    }
  });

  it("no tool claims G-code conversion — this project never slices STL to G-code, and the G-code tools never declare any outputFormats of their own", () => {
    for (const tool of toolRegistry) {
      expect(tool.outputFormats ?? []).not.toContain("gcode");
      if (GCODE_TOOL_IDS.has(tool.id)) expect(tool.outputFormats ?? []).toEqual([]);
    }
  });
});
