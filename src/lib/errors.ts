/**
 * Shared, stable error vocabulary for the whole foundation: file intake,
 * worker communication, WASM loading and the Three.js viewport all report
 * failures through this same set of codes so the UI can react consistently
 * and never needs to guess at free-form error strings.
 */
export type ErrorCode =
  | "UNSUPPORTED_BROWSER"
  | "UNSUPPORTED_FORMAT"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_READ_FAILED"
  | "WORKER_INIT_FAILED"
  | "WORKER_CRASHED"
  | "WASM_UNSUPPORTED"
  | "WASM_LOAD_FAILED"
  | "WASM_COMPILE_FAILED"
  | "WASM_INIT_FAILED"
  | "WEBGL_UNAVAILABLE"
  | "WEBGL_CONTEXT_LOST"
  | "PROCESS_CANCELLED"
  | "STL_FORMAT_UNRECOGNIZED"
  | "STL_BINARY_TRUNCATED"
  | "STL_ASCII_MALFORMED"
  | "STL_INVALID_TRIANGLE_COUNT"
  | "STL_NON_FINITE_VERTEX"
  | "STL_TOO_COMPLEX"
  | "STL_EMPTY_GEOMETRY"
  | "STL_SERIALIZATION_FAILED"
  | "THREEMF_INVALID_PACKAGE"
  | "THREEMF_ZIP_CORRUPT"
  | "THREEMF_ZIP_ENCRYPTED"
  | "THREEMF_PACKAGE_TOO_LARGE"
  | "THREEMF_ZIP_BOMB_SUSPECTED"
  | "THREEMF_MODEL_PART_MISSING"
  | "THREEMF_RELATIONSHIP_INVALID"
  | "THREEMF_XML_MALFORMED"
  | "THREEMF_UNIT_UNSUPPORTED"
  | "THREEMF_OBJECT_DUPLICATE"
  | "THREEMF_OBJECT_MISSING"
  | "THREEMF_COMPONENT_CYCLE"
  | "THREEMF_COMPONENT_DEPTH_EXCEEDED"
  | "THREEMF_VERTEX_INVALID"
  | "THREEMF_TRIANGLE_INVALID"
  | "THREEMF_BUILD_EMPTY"
  | "THREEMF_GEOMETRY_EMPTY"
  | "THREEMF_COMPLEXITY_LIMIT"
  | "OBJ_TEXT_DECODE_FAILED"
  | "OBJ_FILE_TOO_LARGE"
  | "OBJ_VERTEX_INVALID"
  | "OBJ_VERTEX_LIMIT_EXCEEDED"
  | "OBJ_FACE_INVALID"
  | "OBJ_FACE_TOO_SMALL"
  | "OBJ_FACE_VERTEX_LIMIT_EXCEEDED"
  | "OBJ_INDEX_ZERO"
  | "OBJ_INDEX_OUT_OF_RANGE"
  | "OBJ_POLYGON_DEGENERATE"
  | "OBJ_POLYGON_NON_PLANAR"
  | "OBJ_POLYGON_SELF_INTERSECTING"
  | "OBJ_TRIANGULATION_FAILED"
  | "OBJ_TRIANGLE_LIMIT_EXCEEDED"
  | "OBJ_NO_FACE_GEOMETRY"
  | "OBJ_NON_FINITE_COORDINATE"
  | "OBJ_UNSUPPORTED_GEOMETRY"
  | "OBJ_EMPTY_GEOMETRY"
  | "GLB_FILE_TOO_LARGE"
  | "GLB_HEADER_TRUNCATED"
  | "GLB_MAGIC_INVALID"
  | "GLB_VERSION_UNSUPPORTED"
  | "GLB_LENGTH_INVALID"
  | "GLB_CHUNK_TRUNCATED"
  | "GLB_CHUNK_INVALID"
  | "GLB_JSON_CHUNK_MISSING"
  | "GLB_JSON_INVALID"
  | "GLB_BIN_CHUNK_MISSING"
  | "GLB_ASSET_INVALID"
  | "GLB_EXTERNAL_BUFFER_UNSUPPORTED"
  | "GLB_BUFFER_INVALID"
  | "GLB_BUFFER_VIEW_INVALID"
  | "GLB_ACCESSOR_INVALID"
  | "GLB_ACCESSOR_OUT_OF_BOUNDS"
  | "GLB_ACCESSOR_TYPE_UNSUPPORTED"
  | "GLB_SPARSE_ACCESSOR_INVALID"
  | "GLB_INDEX_INVALID"
  | "GLB_POSITION_MISSING"
  | "GLB_PRIMITIVE_MODE_UNSUPPORTED"
  | "GLB_SCENE_MISSING"
  | "GLB_NODE_INVALID"
  | "GLB_NODE_CYCLE"
  | "GLB_NODE_DEPTH_EXCEEDED"
  | "GLB_TRANSFORM_INVALID"
  | "GLB_EXTENSION_REQUIRED_UNSUPPORTED"
  | "GLB_DRACO_UNSUPPORTED"
  | "GLB_MESHOPT_UNSUPPORTED"
  | "GLB_COMPLEXITY_LIMIT"
  | "GLB_EMPTY_GEOMETRY"
  | "OBJ_SERIALIZATION_FAILED"
  | "OBJ_OUTPUT_TOO_LARGE"
  | "OBJ_FACE_LIMIT_EXCEEDED"
  | "OBJ_NON_FINITE_OUTPUT"
  | "OBJ_NO_OUTPUT_GEOMETRY"
  | "OBJ_TEXT_ENCODING_FAILED"
  | "OBJ_INDEX_OVERFLOW"
  | "OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED"
  | "STL_TO_OBJ_DEDUPLICATION_FAILED"
  | "STL_TO_OBJ_CANCELLED"
  | "THREEMF_SERIALIZATION_FAILED"
  | "THREEMF_XML_SERIALIZATION_FAILED"
  | "THREEMF_PACKAGE_WRITE_FAILED"
  | "THREEMF_OUTPUT_TOO_LARGE"
  | "THREEMF_VERTEX_LIMIT_EXCEEDED"
  | "THREEMF_TRIANGLE_LIMIT_EXCEEDED"
  | "THREEMF_NON_FINITE_OUTPUT"
  | "THREEMF_NO_OUTPUT_GEOMETRY"
  | "STL_TO_THREEMF_DEDUPLICATION_FAILED"
  | "STL_TO_THREEMF_CANCELLED"
  | "PLY_FILE_TOO_LARGE"
  | "PLY_MAGIC_INVALID"
  | "PLY_HEADER_UNTERMINATED"
  | "PLY_HEADER_TOO_LARGE"
  | "PLY_FORMAT_MISSING"
  | "PLY_FORMAT_DUPLICATE"
  | "PLY_FORMAT_UNSUPPORTED"
  | "PLY_ELEMENT_INVALID"
  | "PLY_ELEMENT_DUPLICATE"
  | "PLY_ELEMENT_LIMIT_EXCEEDED"
  | "PLY_PROPERTY_INVALID"
  | "PLY_PROPERTY_BEFORE_ELEMENT"
  | "PLY_PROPERTY_DUPLICATE"
  | "PLY_PROPERTY_LIMIT_EXCEEDED"
  | "PLY_UNKNOWN_KEYWORD"
  | "PLY_VERTEX_ELEMENT_MISSING"
  | "PLY_VERTEX_COORDINATE_MISSING"
  | "PLY_VERTEX_COORDINATE_TYPE_INVALID"
  | "PLY_FACE_ELEMENT_MISSING"
  | "PLY_FACE_INDEX_PROPERTY_MISSING"
  | "PLY_FACE_INDEX_PROPERTY_AMBIGUOUS"
  | "PLY_FACE_INDEX_TYPE_INVALID"
  | "PLY_BODY_TRUNCATED"
  | "PLY_ASCII_VALUE_INVALID"
  | "PLY_LIST_LENGTH_INVALID"
  | "PLY_NON_FINITE_VERTEX"
  | "PLY_VERTEX_LIMIT_EXCEEDED"
  | "PLY_FACE_VERTEX_LIMIT_EXCEEDED"
  | "PLY_TRIANGLE_LIMIT_EXCEEDED"
  | "PLY_INDEX_OUT_OF_RANGE"
  | "PLY_NO_FACE_GEOMETRY"
  | "PLY_EMPTY_GEOMETRY"
  | "PLY_FACE_TOO_SMALL"
  | "PLY_POLYGON_DEGENERATE"
  | "PLY_POLYGON_NON_PLANAR"
  | "PLY_POLYGON_SELF_INTERSECTING"
  | "PLY_TRIANGULATION_FAILED"
  | "PLY_COMPLEXITY_LIMIT"
  | "UNKNOWN_ERROR";

/** What the UI is allowed to show. Never includes a stack trace or internal path. */
export interface SafeError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  UNSUPPORTED_BROWSER: "Your browser is missing a feature this tool needs.",
  UNSUPPORTED_FORMAT: "This file format isn't supported by this tool.",
  EMPTY_FILE: "That file appears to be empty.",
  FILE_TOO_LARGE: "That file is larger than this tool currently supports.",
  FILE_READ_FAILED: "The file couldn't be read from your device.",
  WORKER_INIT_FAILED: "The local processing engine couldn't start.",
  WORKER_CRASHED: "Local processing stopped unexpectedly. You can try again.",
  WASM_UNSUPPORTED: "Your browser doesn't support the technology this tool relies on.",
  WASM_LOAD_FAILED: "A required local module couldn't be loaded.",
  WASM_COMPILE_FAILED: "A required local module failed to compile.",
  WASM_INIT_FAILED: "A required local module failed to initialize.",
  WEBGL_UNAVAILABLE: "3D preview isn't available in this browser.",
  WEBGL_CONTEXT_LOST: "The 3D preview was interrupted. You can try again.",
  PROCESS_CANCELLED: "Processing was cancelled.",
  STL_FORMAT_UNRECOGNIZED: "This file doesn't look like a valid STL file.",
  STL_BINARY_TRUNCATED: "This binary STL file is incomplete or corrupted.",
  STL_ASCII_MALFORMED: "This ASCII STL file has a formatting problem MeshKit can't parse.",
  STL_INVALID_TRIANGLE_COUNT: "This STL file reports an impossible number of triangles.",
  STL_NON_FINITE_VERTEX: "This STL file contains invalid coordinate values.",
  STL_TOO_COMPLEX: "This model has more triangles than the free viewer currently supports.",
  STL_EMPTY_GEOMETRY: "This STL file doesn't contain any triangles.",
  STL_SERIALIZATION_FAILED: "MeshKit couldn't build an STL file from this geometry.",
  THREEMF_INVALID_PACKAGE: "This doesn't look like a valid 3MF package.",
  THREEMF_ZIP_CORRUPT: "This 3MF file's package data is corrupted.",
  THREEMF_ZIP_ENCRYPTED: "This 3MF file is password-protected and can't be read locally.",
  THREEMF_PACKAGE_TOO_LARGE: "This 3MF file is larger than this tool currently supports.",
  THREEMF_ZIP_BOMB_SUSPECTED: "This 3MF file's compression looks suspicious and was rejected for safety.",
  THREEMF_MODEL_PART_MISSING: "MeshKit couldn't find a 3D model inside this 3MF package.",
  THREEMF_RELATIONSHIP_INVALID: "This 3MF package's internal file relationships are invalid.",
  THREEMF_XML_MALFORMED: "This 3MF file's model data is malformed and can't be parsed.",
  THREEMF_UNIT_UNSUPPORTED: "This 3MF file declares a measurement unit MeshKit doesn't recognize.",
  THREEMF_OBJECT_DUPLICATE: "This 3MF file has ambiguous duplicate object definitions.",
  THREEMF_OBJECT_MISSING: "This 3MF file references an object that doesn't exist.",
  THREEMF_COMPONENT_CYCLE: "This 3MF file has a circular component reference.",
  THREEMF_COMPONENT_DEPTH_EXCEEDED: "This 3MF file nests components more deeply than this tool supports.",
  THREEMF_VERTEX_INVALID: "This 3MF file contains invalid vertex data.",
  THREEMF_TRIANGLE_INVALID: "This 3MF file contains an invalid triangle reference.",
  THREEMF_BUILD_EMPTY: "This 3MF file doesn't build any visible model.",
  THREEMF_GEOMETRY_EMPTY: "This 3MF file doesn't contain any triangles to convert.",
  THREEMF_COMPLEXITY_LIMIT: "This 3MF model is more complex than this tool currently supports.",
  OBJ_TEXT_DECODE_FAILED: "This OBJ file couldn't be read as text — it may be corrupted or not a real OBJ file.",
  OBJ_FILE_TOO_LARGE: "This OBJ file is larger than this tool currently supports.",
  OBJ_VERTEX_INVALID: "This OBJ file contains an invalid vertex definition.",
  OBJ_VERTEX_LIMIT_EXCEEDED: "This OBJ file has more vertices than this tool currently supports.",
  OBJ_FACE_INVALID: "This OBJ file contains a malformed face definition.",
  OBJ_FACE_TOO_SMALL: "This OBJ file has a face with fewer than three vertices.",
  OBJ_FACE_VERTEX_LIMIT_EXCEEDED: "This OBJ file has a face with more vertices than this tool currently supports.",
  OBJ_INDEX_ZERO: "This OBJ file uses a zero vertex index, which isn't valid in the OBJ format.",
  OBJ_INDEX_OUT_OF_RANGE: "This OBJ file references a vertex that doesn't exist.",
  OBJ_POLYGON_DEGENERATE: "This OBJ file has a face with no measurable area.",
  OBJ_POLYGON_NON_PLANAR: "This OBJ file has a face that isn't flat enough for MeshKit to convert reliably.",
  OBJ_POLYGON_SELF_INTERSECTING: "This OBJ file has a face whose edges cross themselves.",
  OBJ_TRIANGULATION_FAILED: "MeshKit couldn't safely split one of this file's faces into triangles.",
  OBJ_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  OBJ_NO_FACE_GEOMETRY: "This OBJ file doesn't contain any face geometry to convert.",
  OBJ_NON_FINITE_COORDINATE: "This OBJ file contains an invalid coordinate value.",
  OBJ_UNSUPPORTED_GEOMETRY: "This OBJ file only contains lines or points, which STL can't represent.",
  OBJ_EMPTY_GEOMETRY: "This OBJ file doesn't contain any geometry.",
  GLB_FILE_TOO_LARGE: "This GLB file is larger than this tool currently supports.",
  GLB_HEADER_TRUNCATED: "This file is too short to be a valid GLB file.",
  GLB_MAGIC_INVALID: "This doesn't look like a valid GLB file.",
  GLB_VERSION_UNSUPPORTED: "This GLB file uses a glTF version MeshKit doesn't support.",
  GLB_LENGTH_INVALID: "This GLB file's declared size doesn't match its actual size.",
  GLB_CHUNK_TRUNCATED: "This GLB file's internal data is incomplete or corrupted.",
  GLB_CHUNK_INVALID: "This GLB file's internal data is structured unexpectedly.",
  GLB_JSON_CHUNK_MISSING: "This GLB file doesn't contain the required scene description.",
  GLB_JSON_INVALID: "This GLB file's scene description is malformed and can't be parsed.",
  GLB_BIN_CHUNK_MISSING: "This GLB file references binary data that isn't included in the file.",
  GLB_ASSET_INVALID: "This GLB file doesn't declare a supported glTF version.",
  GLB_EXTERNAL_BUFFER_UNSUPPORTED: "This GLB file references external data, which MeshKit can't load locally.",
  GLB_BUFFER_INVALID: "This GLB file's binary data doesn't match its own description.",
  GLB_BUFFER_VIEW_INVALID: "This GLB file references binary data outside its own bounds.",
  GLB_ACCESSOR_INVALID: "This GLB file describes its geometry data inconsistently.",
  GLB_ACCESSOR_OUT_OF_BOUNDS: "This GLB file's geometry data extends beyond the space it's given.",
  GLB_ACCESSOR_TYPE_UNSUPPORTED: "This GLB file uses a geometry data format MeshKit doesn't support.",
  GLB_SPARSE_ACCESSOR_INVALID: "This GLB file's sparse geometry data is invalid.",
  GLB_INDEX_INVALID: "This GLB file references a vertex that doesn't exist.",
  GLB_POSITION_MISSING: "This GLB file has a mesh with no vertex positions.",
  GLB_PRIMITIVE_MODE_UNSUPPORTED: "This GLB file uses a geometry type MeshKit doesn't recognize.",
  GLB_SCENE_MISSING: "MeshKit couldn't find a scene to convert in this GLB file.",
  GLB_NODE_INVALID: "This GLB file's scene structure is invalid.",
  GLB_NODE_CYCLE: "This GLB file's scene structure contains a circular reference.",
  GLB_NODE_DEPTH_EXCEEDED: "This GLB file's scene is nested more deeply than this tool supports.",
  GLB_TRANSFORM_INVALID: "This GLB file contains an invalid position, rotation or scale value.",
  GLB_EXTENSION_REQUIRED_UNSUPPORTED: "This GLB file requires a feature MeshKit doesn't support.",
  GLB_DRACO_UNSUPPORTED: "This GLB file uses Draco mesh compression, which MeshKit doesn't support yet.",
  GLB_MESHOPT_UNSUPPORTED: "This GLB file uses meshopt compression, which MeshKit doesn't support yet.",
  GLB_COMPLEXITY_LIMIT: "This model is more complex than this tool currently supports.",
  GLB_EMPTY_GEOMETRY: "This GLB file doesn't contain any triangles to convert.",
  OBJ_SERIALIZATION_FAILED: "MeshKit couldn't build an OBJ file from this geometry.",
  OBJ_OUTPUT_TOO_LARGE: "The generated OBJ file would be larger than this tool currently supports.",
  OBJ_FACE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  OBJ_NON_FINITE_OUTPUT: "MeshKit found an invalid coordinate value while building the OBJ file.",
  OBJ_NO_OUTPUT_GEOMETRY: "This STL file has no usable triangles to convert to OBJ.",
  OBJ_TEXT_ENCODING_FAILED: "MeshKit couldn't encode the generated OBJ file as text.",
  OBJ_INDEX_OVERFLOW: "This model has more vertices than an OBJ file can reference.",
  OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED: "This model has more unique vertices than this tool currently supports.",
  STL_TO_OBJ_DEDUPLICATION_FAILED: "MeshKit couldn't process this model's vertex data.",
  STL_TO_OBJ_CANCELLED: "Processing was cancelled.",
  THREEMF_SERIALIZATION_FAILED: "MeshKit couldn't build a 3MF file from this geometry.",
  THREEMF_XML_SERIALIZATION_FAILED: "MeshKit couldn't build this model's 3MF description.",
  THREEMF_PACKAGE_WRITE_FAILED: "MeshKit couldn't package the generated 3MF file.",
  THREEMF_OUTPUT_TOO_LARGE: "The generated 3MF file would be larger than this tool currently supports.",
  THREEMF_VERTEX_LIMIT_EXCEEDED: "This model has more unique vertices than this tool currently supports.",
  THREEMF_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  THREEMF_NON_FINITE_OUTPUT: "MeshKit found an invalid coordinate value while building the 3MF file.",
  THREEMF_NO_OUTPUT_GEOMETRY: "This STL file has no usable triangles to convert to 3MF.",
  STL_TO_THREEMF_DEDUPLICATION_FAILED: "MeshKit couldn't process this model's vertex data.",
  STL_TO_THREEMF_CANCELLED: "Processing was cancelled.",
  PLY_FILE_TOO_LARGE: "This PLY file is larger than this tool currently supports.",
  PLY_MAGIC_INVALID: "This doesn't look like a valid PLY file.",
  PLY_HEADER_UNTERMINATED: "This PLY file's header is incomplete or corrupted.",
  PLY_HEADER_TOO_LARGE: "This PLY file's header is larger than this tool currently supports.",
  PLY_FORMAT_MISSING: "This PLY file doesn't declare a format (ASCII or binary).",
  PLY_FORMAT_DUPLICATE: "This PLY file declares its format more than once.",
  PLY_FORMAT_UNSUPPORTED: "This PLY file uses a format or version MeshKit doesn't support.",
  PLY_ELEMENT_INVALID: "This PLY file has a malformed element declaration.",
  PLY_ELEMENT_DUPLICATE: "This PLY file declares the same element name more than once.",
  PLY_ELEMENT_LIMIT_EXCEEDED: "This PLY file declares more elements than this tool currently supports.",
  PLY_PROPERTY_INVALID: "This PLY file has a malformed property declaration.",
  PLY_PROPERTY_BEFORE_ELEMENT: "This PLY file declares a property before any element.",
  PLY_PROPERTY_DUPLICATE: "This PLY file declares the same property name more than once on one element.",
  PLY_PROPERTY_LIMIT_EXCEEDED: "This PLY file declares more properties on one element than this tool currently supports.",
  PLY_UNKNOWN_KEYWORD: "This PLY file's header contains a line MeshKit doesn't recognize.",
  PLY_VERTEX_ELEMENT_MISSING: "This PLY file doesn't declare a vertex element.",
  PLY_VERTEX_COORDINATE_MISSING: "This PLY file's vertex element is missing an x, y or z coordinate.",
  PLY_VERTEX_COORDINATE_TYPE_INVALID: "This PLY file declares a vertex coordinate as a list, which isn't valid.",
  PLY_FACE_ELEMENT_MISSING: "This PLY file only contains points, not faces — MeshKit can't build a surface from points alone.",
  PLY_FACE_INDEX_PROPERTY_MISSING: "This PLY file's face element doesn't declare a vertex index list MeshKit can use.",
  PLY_FACE_INDEX_PROPERTY_AMBIGUOUS: "This PLY file's face element declares more than one vertex index list, which is ambiguous.",
  PLY_FACE_INDEX_TYPE_INVALID: "This PLY file's face vertex index list isn't declared as an integer type.",
  PLY_BODY_TRUNCATED: "This PLY file's data is incomplete or corrupted.",
  PLY_ASCII_VALUE_INVALID: "This PLY file contains a value MeshKit couldn't read as a number.",
  PLY_LIST_LENGTH_INVALID: "This PLY file declares an invalid list length.",
  PLY_NON_FINITE_VERTEX: "This PLY file contains an invalid coordinate value.",
  PLY_VERTEX_LIMIT_EXCEEDED: "This PLY file has more vertices than this tool currently supports.",
  PLY_FACE_VERTEX_LIMIT_EXCEEDED: "This PLY file has a face with more vertices than this tool currently supports.",
  PLY_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  PLY_INDEX_OUT_OF_RANGE: "This PLY file references a vertex that doesn't exist.",
  PLY_NO_FACE_GEOMETRY: "This PLY file doesn't contain any face geometry to convert.",
  PLY_EMPTY_GEOMETRY: "This PLY file doesn't contain any geometry.",
  PLY_FACE_TOO_SMALL: "This PLY file has a face with fewer than three vertices.",
  PLY_POLYGON_DEGENERATE: "This PLY file has a face with no measurable area.",
  PLY_POLYGON_NON_PLANAR: "This PLY file has a face that isn't flat enough for MeshKit to convert reliably.",
  PLY_POLYGON_SELF_INTERSECTING: "This PLY file has a face whose edges cross themselves.",
  PLY_TRIANGULATION_FAILED: "MeshKit couldn't safely split one of this file's faces into triangles.",
  PLY_COMPLEXITY_LIMIT: "This model is more complex than this tool currently supports.",
  UNKNOWN_ERROR: "Something went wrong.",
};

/** Errors a user can plausibly retry from without reloading the page. */
const RECOVERABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "PROCESS_CANCELLED",
  "WEBGL_CONTEXT_LOST",
  "WORKER_CRASHED",
  "FILE_READ_FAILED",
  "STL_FORMAT_UNRECOGNIZED",
  "STL_BINARY_TRUNCATED",
  "STL_ASCII_MALFORMED",
  "STL_INVALID_TRIANGLE_COUNT",
  "STL_NON_FINITE_VERTEX",
  "STL_TOO_COMPLEX",
  "STL_EMPTY_GEOMETRY",
  "THREEMF_INVALID_PACKAGE",
  "THREEMF_ZIP_CORRUPT",
  "THREEMF_ZIP_ENCRYPTED",
  "THREEMF_PACKAGE_TOO_LARGE",
  "THREEMF_ZIP_BOMB_SUSPECTED",
  "THREEMF_MODEL_PART_MISSING",
  "THREEMF_RELATIONSHIP_INVALID",
  "THREEMF_XML_MALFORMED",
  "THREEMF_UNIT_UNSUPPORTED",
  "THREEMF_OBJECT_DUPLICATE",
  "THREEMF_OBJECT_MISSING",
  "THREEMF_COMPONENT_CYCLE",
  "THREEMF_COMPONENT_DEPTH_EXCEEDED",
  "THREEMF_VERTEX_INVALID",
  "THREEMF_TRIANGLE_INVALID",
  "THREEMF_BUILD_EMPTY",
  "THREEMF_GEOMETRY_EMPTY",
  "THREEMF_COMPLEXITY_LIMIT",
  "OBJ_TEXT_DECODE_FAILED",
  "OBJ_FILE_TOO_LARGE",
  "OBJ_VERTEX_INVALID",
  "OBJ_VERTEX_LIMIT_EXCEEDED",
  "OBJ_FACE_INVALID",
  "OBJ_FACE_TOO_SMALL",
  "OBJ_FACE_VERTEX_LIMIT_EXCEEDED",
  "OBJ_INDEX_ZERO",
  "OBJ_INDEX_OUT_OF_RANGE",
  "OBJ_POLYGON_DEGENERATE",
  "OBJ_POLYGON_NON_PLANAR",
  "OBJ_POLYGON_SELF_INTERSECTING",
  "OBJ_TRIANGULATION_FAILED",
  "OBJ_TRIANGLE_LIMIT_EXCEEDED",
  "OBJ_NO_FACE_GEOMETRY",
  "OBJ_NON_FINITE_COORDINATE",
  "OBJ_UNSUPPORTED_GEOMETRY",
  "OBJ_EMPTY_GEOMETRY",
  "GLB_FILE_TOO_LARGE",
  "GLB_HEADER_TRUNCATED",
  "GLB_MAGIC_INVALID",
  "GLB_VERSION_UNSUPPORTED",
  "GLB_LENGTH_INVALID",
  "GLB_CHUNK_TRUNCATED",
  "GLB_CHUNK_INVALID",
  "GLB_JSON_CHUNK_MISSING",
  "GLB_JSON_INVALID",
  "GLB_BIN_CHUNK_MISSING",
  "GLB_ASSET_INVALID",
  "GLB_EXTERNAL_BUFFER_UNSUPPORTED",
  "GLB_BUFFER_INVALID",
  "GLB_BUFFER_VIEW_INVALID",
  "GLB_ACCESSOR_INVALID",
  "GLB_ACCESSOR_OUT_OF_BOUNDS",
  "GLB_ACCESSOR_TYPE_UNSUPPORTED",
  "GLB_SPARSE_ACCESSOR_INVALID",
  "GLB_INDEX_INVALID",
  "GLB_POSITION_MISSING",
  "GLB_PRIMITIVE_MODE_UNSUPPORTED",
  "GLB_SCENE_MISSING",
  "GLB_NODE_INVALID",
  "GLB_NODE_CYCLE",
  "GLB_NODE_DEPTH_EXCEEDED",
  "GLB_TRANSFORM_INVALID",
  "GLB_EXTENSION_REQUIRED_UNSUPPORTED",
  "GLB_DRACO_UNSUPPORTED",
  "GLB_MESHOPT_UNSUPPORTED",
  "GLB_COMPLEXITY_LIMIT",
  "GLB_EMPTY_GEOMETRY",
  "OBJ_SERIALIZATION_FAILED",
  "OBJ_OUTPUT_TOO_LARGE",
  "OBJ_FACE_LIMIT_EXCEEDED",
  "OBJ_NON_FINITE_OUTPUT",
  "OBJ_NO_OUTPUT_GEOMETRY",
  "OBJ_TEXT_ENCODING_FAILED",
  "OBJ_INDEX_OVERFLOW",
  "OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED",
  "STL_TO_OBJ_DEDUPLICATION_FAILED",
  "STL_TO_OBJ_CANCELLED",
  "THREEMF_SERIALIZATION_FAILED",
  "THREEMF_XML_SERIALIZATION_FAILED",
  "THREEMF_PACKAGE_WRITE_FAILED",
  "THREEMF_OUTPUT_TOO_LARGE",
  "THREEMF_VERTEX_LIMIT_EXCEEDED",
  "THREEMF_TRIANGLE_LIMIT_EXCEEDED",
  "THREEMF_NON_FINITE_OUTPUT",
  "THREEMF_NO_OUTPUT_GEOMETRY",
  "STL_TO_THREEMF_DEDUPLICATION_FAILED",
  "STL_TO_THREEMF_CANCELLED",
  "PLY_FILE_TOO_LARGE",
  "PLY_MAGIC_INVALID",
  "PLY_HEADER_UNTERMINATED",
  "PLY_HEADER_TOO_LARGE",
  "PLY_FORMAT_MISSING",
  "PLY_FORMAT_DUPLICATE",
  "PLY_FORMAT_UNSUPPORTED",
  "PLY_ELEMENT_INVALID",
  "PLY_ELEMENT_DUPLICATE",
  "PLY_ELEMENT_LIMIT_EXCEEDED",
  "PLY_PROPERTY_INVALID",
  "PLY_PROPERTY_BEFORE_ELEMENT",
  "PLY_PROPERTY_DUPLICATE",
  "PLY_PROPERTY_LIMIT_EXCEEDED",
  "PLY_UNKNOWN_KEYWORD",
  "PLY_VERTEX_ELEMENT_MISSING",
  "PLY_VERTEX_COORDINATE_MISSING",
  "PLY_VERTEX_COORDINATE_TYPE_INVALID",
  "PLY_FACE_ELEMENT_MISSING",
  "PLY_FACE_INDEX_PROPERTY_MISSING",
  "PLY_FACE_INDEX_PROPERTY_AMBIGUOUS",
  "PLY_FACE_INDEX_TYPE_INVALID",
  "PLY_BODY_TRUNCATED",
  "PLY_ASCII_VALUE_INVALID",
  "PLY_LIST_LENGTH_INVALID",
  "PLY_NON_FINITE_VERTEX",
  "PLY_VERTEX_LIMIT_EXCEEDED",
  "PLY_FACE_VERTEX_LIMIT_EXCEEDED",
  "PLY_TRIANGLE_LIMIT_EXCEEDED",
  "PLY_INDEX_OUT_OF_RANGE",
  "PLY_NO_FACE_GEOMETRY",
  "PLY_EMPTY_GEOMETRY",
  "PLY_FACE_TOO_SMALL",
  "PLY_POLYGON_DEGENERATE",
  "PLY_POLYGON_NON_PLANAR",
  "PLY_POLYGON_SELF_INTERSECTING",
  "PLY_TRIANGULATION_FAILED",
  "PLY_COMPLEXITY_LIMIT",
]);

/**
 * Build a safe, user-facing error. `detail` may only be used for information
 * that is already safe to show (e.g. "Supported formats: STL, OBJ") — never
 * for raw exception text.
 */
export function createSafeError(code: ErrorCode, detail?: string): SafeError {
  return {
    code,
    message: detail ?? SAFE_MESSAGES[code],
    recoverable: RECOVERABLE_CODES.has(code),
  };
}

/**
 * Map an unexpected thrown value to a safe error, logging the real cause
 * only to the developer console in dev builds. The UI never sees `cause`.
 */
export function toSafeError(code: ErrorCode, cause: unknown): SafeError {
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.debug(`[${code}]`, cause);
  }
  return createSafeError(code);
}

export function isSafeError(value: unknown): value is SafeError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.message === "string" && typeof v.recoverable === "boolean";
}
