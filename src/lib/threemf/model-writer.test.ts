import { describe, expect, it } from "vitest";
import { writeModelXML } from "./model-writer";
import { deduplicateVertices } from "../mesh/deduplicate";
import { parseThreeMFModel } from "./model-parser";
import { DEFAULT_THREEMF_LIMITS } from "./types";
import type { DeduplicatedGeometry } from "../mesh/deduplicate";

const LIMITS = { maxTriangles: 3_000_000 };
const DEDUP_LIMITS = { maxUniqueVertices: 1_000_000 };

async function triangleGeometry(): Promise<DeduplicatedGeometry> {
  return deduplicateVertices(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), DEDUP_LIMITS);
}

describe("writeModelXML — structure", () => {
  it("starts with the correct XML declaration", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
  });

  it("uses the correct core namespace and declares unit=millimeter", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect(xml).toContain('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"');
    expect(xml).toContain('unit="millimeter"');
  });

  it("has exactly one resources section, one object and one mesh", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect((xml.match(/<resources>/g) ?? []).length).toBe(1);
    expect((xml.match(/<object /g) ?? []).length).toBe(1);
    expect((xml.match(/<mesh>/g) ?? []).length).toBe(1);
  });

  it("has exactly one build item", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect((xml.match(/<item /g) ?? []).length).toBe(1);
    expect(xml).toContain('<item objectid="1"/>');
  });

  it("emits one vertex element per unique vertex and one triangle element per face", async () => {
    const geometry = await deduplicateVertices(
      Float32Array.from([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0]),
      DEDUP_LIMITS,
    );
    const xml = await writeModelXML(geometry, LIMITS);
    expect((xml.match(/<vertex /g) ?? []).length).toBe(4);
    expect((xml.match(/<triangle /g) ?? []).length).toBe(2);
  });

  it("uses zero-based vertex indices in triangle records", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect(xml).toContain('<triangle v1="0" v2="1" v3="2"/>');
  });

  it("preserves triangle winding (index order matches source order)", async () => {
    const reversed = await deduplicateVertices(Float32Array.from([0, 1, 0, 1, 0, 0, 0, 0, 0]), DEDUP_LIMITS);
    const xml = await writeModelXML(reversed, LIMITS);
    expect(xml).toContain('<triangle v1="0" v2="1" v3="2"/>');
  });

  it("produces deterministic element ordering and coordinate formatting across repeated calls", async () => {
    const geometry = await triangleGeometry();
    const first = await writeModelXML(geometry, LIMITS);
    const second = await writeModelXML(geometry, LIMITS);
    expect(first).toBe(second);
  });

  it("formats coordinates via the shared Float32 formatter (no trailing zeros, -0 normalized)", async () => {
    const geometry = await deduplicateVertices(Float32Array.from([-0, 1.5, 0, 2, 0, 0, 0, 2, 0]), DEDUP_LIMITS);
    const xml = await writeModelXML(geometry, LIMITS);
    expect(xml).toContain('<vertex x="0" y="1.5" z="0"/>');
  });

  it("never contains an original filename or STL header text", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect(xml).not.toContain("model.stl");
    expect(xml).not.toContain("solid");
  });

  it("never contains a DOCTYPE, entity declaration or extra processing instruction", async () => {
    const xml = await writeModelXML(await triangleGeometry(), LIMITS);
    expect(xml).not.toMatch(/<!DOCTYPE/i);
    expect(xml).not.toMatch(/<!ENTITY/i);
    expect((xml.match(/<\?/g) ?? []).length).toBe(1); // only the XML declaration itself
  });
});

describe("writeModelXML — round trip through the production 3MF reader", () => {
  it("parses successfully with parseThreeMFModel and matches source geometry", async () => {
    const geometry = await deduplicateVertices(Float32Array.from([0, 0, 0, 2, 0, 0, 2, 2, 0]), DEDUP_LIMITS);
    const xml = await writeModelXML(geometry, LIMITS);
    const model = parseThreeMFModel(xml, DEFAULT_THREEMF_LIMITS);
    expect(model.unit).toBe("millimeter");
    const object = model.objects.get("1");
    expect(object?.kind).toBe("mesh");
    if (object?.kind === "mesh") {
      expect(object.vertices.length).toBe(9);
      expect(object.triangleIndices.length).toBe(3);
    }
    expect(model.buildItems).toHaveLength(1);
    expect(model.buildItems[0].objectId).toBe("1");
  });
});

describe("writeModelXML — limits and errors", () => {
  it("rejects empty geometry", async () => {
    const empty: DeduplicatedGeometry = { vertices: new Float32Array(0), triangleVertexIndices: new Uint32Array(0), sourceVertexCount: 0, uniqueVertexCount: 0 };
    await expect(writeModelXML(empty, LIMITS)).rejects.toMatchObject({ code: "THREEMF_NO_OUTPUT_GEOMETRY" });
  });

  it("enforces the triangle-count limit", async () => {
    const geometry = await triangleGeometry();
    await expect(writeModelXML(geometry, { maxTriangles: 0 })).rejects.toMatchObject({ code: "THREEMF_TRIANGLE_LIMIT_EXCEEDED" });
  });

  it("supports cancellation during XML writing", async () => {
    const n = 300_000;
    const positions = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const base = t * 9;
      positions[base] = t;
      positions[base + 3] = t + 1;
      positions[base + 7] = 1;
    }
    const geometry = await deduplicateVertices(positions, { maxUniqueVertices: 10_000_000 });
    let cancelled = false;
    const promise = writeModelXML(geometry, { maxTriangles: 10_000_000 }, { isCancelled: () => cancelled, yieldEvery: 1000 });
    cancelled = true;
    await expect(promise).rejects.toThrow("cancelled");
  });
});
