import { describe, expect, it } from "vitest";
import { resolveThreeMFViewerPackage, resolveThreeMFViewerScene } from "./viewer-scene";
import { build3MFPackage, buildModelXML, expectThreeMFError, meshObject, simpleTriangleMesh } from "./test-fixtures";
import { DEFAULT_THREEMF_VIEWER_LIMITS, type ThreeMFViewerLimits } from "./viewer-types";

const LIMITS = DEFAULT_THREEMF_VIEWER_LIMITS;

describe("resolveThreeMFViewerScene — scene hierarchy", () => {
  it("resolves one mesh object referenced directly by a build item", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ buildItemIndex: 0, meshObjectId: "1", componentPath: [] });
    expect(result.resolvedInstanceCount).toBe(1);
    expect(result.meshObjectCount).toBe(1);
  });

  it("resolves multiple mesh objects from multiple build items, preserving order", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), simpleTriangleMesh("2")],
      buildItems: [{ objectId: "2" }, { objectId: "1" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments.map((s) => s.meshObjectId)).toEqual(["2", "1"]);
    expect(result.segments.map((s) => s.buildItemIndex)).toEqual([0, 1]);
  });

  it("resolves a component object referencing a mesh", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), { id: "2", kind: "components", components: [{ objectId: "1" }] }],
      buildItems: [{ objectId: "2" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].meshObjectId).toBe("1");
    expect(result.segments[0].componentPath).toEqual([1]);
    expect(result.componentObjectCount).toBe(1);
  });

  it("resolves nested components, preserving the full component path", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1" }] },
        { id: "3", kind: "components", components: [{ objectId: "2" }] },
      ],
      buildItems: [{ objectId: "3" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].componentPath).toEqual([1, 1]);
  });

  it("resolves multiple instances of the same mesh object as independent segments", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }, { objectId: "1", transform: "1 0 0 0 1 0 0 0 1 5 0 0" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments).toHaveLength(2);
    expect(result.resolvedInstanceCount).toBe(2);
    expect(result.meshObjectCount).toBe(1); // declared once
  });

  it("labels a reflecting transform as reflected", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1", transform: "-1 0 0 0 1 0 0 0 1 0 0 0" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments[0].transformSummary).toBe("reflected");
  });

  it("labels identity and translation-only transforms correctly", () => {
    const identityXml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    expect(resolveThreeMFViewerScene(identityXml, LIMITS).segments[0].transformSummary).toBe("identity");

    const translatedXml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1", transform: "1 0 0 0 1 0 0 0 1 5 0 0" }],
    });
    expect(resolveThreeMFViewerScene(translatedXml, LIMITS).segments[0].transformSummary).toBe("translated");
  });

  it("rejects a component cycle", () => {
    const xml = buildModelXML({
      objects: [{ id: "1", kind: "components", components: [{ objectId: "1" }] }],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, LIMITS), "THREEMF_COMPONENT_CYCLE");
  });

  it("enforces the component depth ceiling", () => {
    const limits: ThreeMFViewerLimits = { ...LIMITS, maxComponentDepth: 2 };
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1" }] },
        { id: "3", kind: "components", components: [{ objectId: "2" }] },
        { id: "4", kind: "components", components: [{ objectId: "3" }] },
      ],
      buildItems: [{ objectId: "4" }],
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, limits), "THREEMF_COMPONENT_DEPTH_EXCEEDED");
  });

  it("enforces the viewer segment-count ceiling", () => {
    const limits: ThreeMFViewerLimits = { ...LIMITS, maxSegments: 1 };
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }, { objectId: "1" }],
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, limits), "THREEMF_VIEWER_SEGMENT_LIMIT");
  });

  it("gives each segment a correct, non-overlapping triangle range", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1"), meshObject("2", [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]], [[0, 1, 2], [1, 3, 2]])],
      buildItems: [{ objectId: "1" }, { objectId: "2" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments[0]).toMatchObject({ triangleStart: 0, triangleCount: 1 });
    expect(result.segments[1]).toMatchObject({ triangleStart: 1, triangleCount: 2 });
    expect(result.triangleCount).toBe(3);
  });

  it("reads an object's own display name when present", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), name: "My Part" }],
      buildItems: [{ objectId: "1" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments[0].displayName).toBe("My Part");
  });

  it("skips a production-extension cross-part component reference and warns, without failing the whole file", () => {
    const xml = buildModelXML({
      objects: [
        simpleTriangleMesh("1"),
        { id: "2", kind: "components", components: [{ objectId: "1" }, { objectId: "99", path: "/3D/other.model" }] },
      ],
      buildItems: [{ objectId: "2" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.segments).toHaveLength(1);
    expect(result.warnings.some((w) => w.code === "cross-part-reference-skipped")).toBe(true);
  });
});

describe("resolveThreeMFViewerScene — units", () => {
  const UNIT_MM: [string, number][] = [
    ["micron", 0.001],
    ["millimeter", 1],
    ["centimeter", 10],
    ["inch", 25.4],
    ["foot", 304.8],
    ["meter", 1000],
  ];

  it.each(UNIT_MM)("converts %s to millimeters exactly once", (unit, factor) => {
    const xml = buildModelXML({ unit, objects: [meshObject("1", [[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 1, 2]])], buildItems: [{ objectId: "1" }] });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.declaredUnit).toBe(unit);
    expect(result.millimeterScale).toBe(factor);
    expect(result.boundsMillimeters.max[0]).toBeCloseTo(10 * factor, 6);
    // Declared-unit dimensions are derived by dividing back out — never a second independent conversion.
    expect(result.boundsMillimeters.max[0] / result.millimeterScale).toBeCloseTo(10, 6);
  });
});

describe("resolveThreeMFViewerScene — embedded colors", () => {
  it("resolves a base-material color from an object's default pid/pindex", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "10", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Red" displaycolor="#FF0000"/></basematerials>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.hasEmbeddedColors).toBe(true);
    expect(result.colors).toBeDefined();
    expect(result.colors![0]).toBeCloseTo(1, 5); // linear red channel
    expect(result.colors![1]).toBeCloseTo(0, 5);
    expect(result.segments[0].colorResourceRef).toBe("10:0");
  });

  it("resolves a triangle-level override with only p1 given, falling back to p1 for p2/p3", () => {
    const xml = buildModelXML({
      objects: [
        {
          id: "1",
          kind: "mesh",
          vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
          triangles: [[0, 1, 2]],
          triangleXML: [`<triangle v1="0" v2="1" v3="2" pid="10" p1="0"/>`],
        },
      ],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Blue" displaycolor="#0000FF"/></basematerials>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    // 9 floats: 3 corners x rgb. All three corners should match p1's color (0000FF).
    const c = result.colors!;
    for (let corner = 0; corner < 3; corner++) {
      expect(c[corner * 3]).toBeCloseTo(0, 5);
      expect(c[corner * 3 + 1]).toBeCloseTo(0, 5);
      expect(c[corner * 3 + 2]).toBeCloseTo(1, 5);
    }
  });

  it("resolves distinct per-corner colors when p1/p2/p3 differ", () => {
    const xml = buildModelXML({
      objects: [
        {
          id: "1",
          kind: "mesh",
          vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
          triangles: [[0, 1, 2]],
          triangleXML: [`<triangle v1="0" v2="1" v3="2" pid="10" p1="0" p2="1" p3="2"/>`],
        },
      ],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<colorgroup id="10"><color color="#FF0000"/><color color="#00FF00"/><color color="#0000FF"/></colorgroup>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    const c = result.colors!;
    expect(c[0]).toBeCloseTo(1, 5); // corner 1: red
    expect(c[3]).toBeCloseTo(0, 5); // corner 2: green channel present...
    expect(c[4]).toBeCloseTo(1, 5);
    expect(c[8]).toBeCloseTo(1, 5); // corner 3: blue
  });

  it("resolves a color-group reference", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "20", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<colorgroup id="20"><color color="#00FF00"/></colorgroup>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.hasEmbeddedColors).toBe(true);
    expect(result.colors![1]).toBeCloseTo(1, 5);
  });

  it("tracks alpha and flags transparent colors without rendering transparency", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "10", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Glass" displaycolor="#0000FF80"/></basematerials>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.hasTransparentColors).toBe(true);
    expect(result.warnings.some((w) => w.code === "alpha-not-rendered")).toBe(true);
  });

  it("rejects a malformed hexadecimal color value", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "10", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Bad" displaycolor="not-a-color"/></basematerials>`,
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, LIMITS), "THREEMF_COLOR_REFERENCE_INVALID");
  });

  it("warns and falls back to neutral for a dangling pid reference, without failing the file", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "999", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.hasEmbeddedColors).toBe(false);
    expect(result.warnings.some((w) => w.code === "color-reference-invalid")).toBe(true);
  });

  it("warns and falls back to neutral for an out-of-range pindex", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "10", pindex: 5 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Red" displaycolor="#FF0000"/></basematerials>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.warnings.some((w) => w.code === "color-reference-invalid")).toBe(true);
  });

  it("has no color array (neutral fallback) when the file declares no color data", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.hasEmbeddedColors).toBe(false);
    expect(result.colors).toBeUndefined();
  });

  it("produces a color array sized 9 floats per triangle when color data exists", () => {
    const xml = buildModelXML({
      objects: [{ ...simpleTriangleMesh("1"), pid: "10", pindex: 0 }],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<basematerials id="10"><base name="Red" displaycolor="#FF0000"/></basematerials>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.colors!.length).toBe(result.triangleCount * 9);
  });
});

describe("resolveThreeMFViewerScene — metadata", () => {
  it("extracts a metadata entry's name and text value", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<metadata name="Title">My Model</metadata>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.metadata).toEqual([{ name: "Title", value: "My Model" }]);
  });

  it("normalizes internal whitespace in a metadata value", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<metadata name="Description">Line one\n\n   Line   two</metadata>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.metadata[0].value).toBe("Line one Line two");
  });

  it("truncates a metadata value longer than the configured limit", () => {
    const limits: ThreeMFViewerLimits = { ...LIMITS, maxMetadataValueLength: 10 };
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<metadata name="Description">this value is much longer than ten characters</metadata>`,
    });
    const result = resolveThreeMFViewerScene(xml, limits);
    expect(result.metadata[0].value.length).toBe(10);
    expect(result.metadata[0].value.endsWith("…")).toBe(true);
  });

  it("enforces the metadata entry-count ceiling", () => {
    const limits: ThreeMFViewerLimits = { ...LIMITS, maxMetadataEntries: 1 };
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<metadata name="Title">A</metadata><metadata name="Designer">B</metadata>`,
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, limits), "THREEMF_VIEWER_METADATA_LIMIT");
  });

  it("decodes entities as literal text rather than markup", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<metadata name="Title">&lt;b&gt;bold&lt;/b&gt;</metadata>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.metadata[0].value).toBe("<b>bold</b>");
  });
});

describe("resolveThreeMFViewerScene — unsupported features", () => {
  it("warns about texture resources without failing, and counts them", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<texture2d id="5" path="/2D/tex.png" contenttype="image/png"/><texture2dgroup id="6" texid="5"></texture2dgroup>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.warnings.some((w) => w.code === "textures-not-rendered")).toBe(true);
    expect(result.colorResources.textureResourceCount).toBe(1);
  });

  it("warns about a beam lattice without failing", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: "",
    }).replace("<mesh>", "<mesh><beamlattice></beamlattice>");
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.warnings.some((w) => w.code === "beam-lattice-not-rendered")).toBe(true);
    expect(result.triangleCount).toBeGreaterThan(0);
  });

  it("warns about slice-stack content without failing", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<slicestack id="30"><slice ztop="1"></slice></slicestack>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.warnings.some((w) => w.code === "slice-stack-not-rendered")).toBe(true);
  });

  it("warns generically about a secure-content keystore while still rendering core geometry", () => {
    const xml = buildModelXML({
      objects: [simpleTriangleMesh("1")],
      buildItems: [{ objectId: "1" }],
      resourcesXML: `<keystore></keystore>`,
    });
    const result = resolveThreeMFViewerScene(xml, LIMITS);
    expect(result.warnings.some((w) => w.code === "unsupported-extension-content")).toBe(true);
    expect(result.triangleCount).toBe(1);
  });
});

describe("resolveThreeMFViewerScene — lifecycle", () => {
  it("throws THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY when nothing resolves", () => {
    const xml = buildModelXML({
      objects: [{ id: "1", kind: "components", components: [{ objectId: "99", path: "/3D/other.model" }] }],
      buildItems: [{ objectId: "1" }],
    });
    expectThreeMFError(() => resolveThreeMFViewerScene(xml, LIMITS), "THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY");
  });

  it("resolves a full package end to end via resolveThreeMFViewerPackage, including entry count", () => {
    const xml = buildModelXML({ objects: [simpleTriangleMesh("1")], buildItems: [{ objectId: "1" }] });
    const buffer = build3MFPackage(xml);
    const result = resolveThreeMFViewerPackage(buffer, LIMITS);
    expect(result.triangleCount).toBe(1);
    expect(result.packageEntryCount).toBeGreaterThanOrEqual(3); // rels + model + [Content_Types].xml
  });
});
