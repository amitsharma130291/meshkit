import { describe, expect, it } from "vitest";
import { isIntegerScalarType, normalizeScalarType, parseAsciiScalar, readScalar, scalarByteSize } from "./scalar-types";

describe("normalizeScalarType", () => {
  it("maps both the Stanford names and the explicit-width aliases to the same normalized type", () => {
    expect(normalizeScalarType("char")).toBe("int8");
    expect(normalizeScalarType("int8")).toBe("int8");
    expect(normalizeScalarType("uchar")).toBe("uint8");
    expect(normalizeScalarType("uint8")).toBe("uint8");
    expect(normalizeScalarType("short")).toBe("int16");
    expect(normalizeScalarType("int16")).toBe("int16");
    expect(normalizeScalarType("ushort")).toBe("uint16");
    expect(normalizeScalarType("uint16")).toBe("uint16");
    expect(normalizeScalarType("int")).toBe("int32");
    expect(normalizeScalarType("int32")).toBe("int32");
    expect(normalizeScalarType("uint")).toBe("uint32");
    expect(normalizeScalarType("uint32")).toBe("uint32");
    expect(normalizeScalarType("float")).toBe("float32");
    expect(normalizeScalarType("float32")).toBe("float32");
    expect(normalizeScalarType("double")).toBe("float64");
    expect(normalizeScalarType("float64")).toBe("float64");
  });

  it("returns null for an unrecognized token", () => {
    expect(normalizeScalarType("string")).toBeNull();
    expect(normalizeScalarType("")).toBeNull();
  });
});

describe("isIntegerScalarType", () => {
  it("treats float32/float64 as non-integer and everything else as integer", () => {
    expect(isIntegerScalarType("float32")).toBe(false);
    expect(isIntegerScalarType("float64")).toBe(false);
    expect(isIntegerScalarType("int8")).toBe(true);
    expect(isIntegerScalarType("uint32")).toBe(true);
  });
});

describe("scalarByteSize", () => {
  it("reports the correct byte width for every type", () => {
    expect(scalarByteSize("int8")).toBe(1);
    expect(scalarByteSize("uint8")).toBe(1);
    expect(scalarByteSize("int16")).toBe(2);
    expect(scalarByteSize("uint16")).toBe(2);
    expect(scalarByteSize("int32")).toBe(4);
    expect(scalarByteSize("uint32")).toBe(4);
    expect(scalarByteSize("float32")).toBe(4);
    expect(scalarByteSize("float64")).toBe(8);
  });
});

describe("readScalar", () => {
  it("reads every type correctly in both little- and big-endian order", () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    view.setInt32(0, -12345, true);
    expect(readScalar(view, 0, "int32", true)).toBe(-12345);

    view.setUint32(0, 12345, false);
    expect(readScalar(view, 0, "uint32", false)).toBe(12345);

    view.setFloat64(0, 3.14159, true);
    expect(readScalar(view, 0, "float64", true)).toBeCloseTo(3.14159, 5);

    view.setFloat32(0, 2.5, false);
    expect(readScalar(view, 0, "float32", false)).toBe(2.5);

    view.setUint8(0, 200);
    expect(readScalar(view, 0, "uint8", true)).toBe(200);

    view.setInt16(0, -1000, true);
    expect(readScalar(view, 0, "int16", true)).toBe(-1000);
  });
});

describe("parseAsciiScalar", () => {
  it("parses a plain numeric token regardless of declared type", () => {
    expect(parseAsciiScalar("42")).toBe(42);
    expect(parseAsciiScalar("-3.5")).toBe(-3.5);
    expect(parseAsciiScalar("1e3")).toBe(1000);
  });

  it("returns NaN for a non-numeric token, left for the caller to reject", () => {
    expect(Number.isNaN(parseAsciiScalar("abc"))).toBe(true);
  });
});
