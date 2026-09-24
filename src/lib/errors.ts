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
  | "THREEMF_VIEWER_SEGMENT_LIMIT"
  | "THREEMF_VIEWER_METADATA_LIMIT"
  | "THREEMF_VIEWER_COLOR_LIMIT"
  | "THREEMF_VIEWER_MATERIAL_LIMIT"
  | "THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY"
  | "THREEMF_COLOR_REFERENCE_INVALID"
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
  | "OBJ_VIEWER_SEGMENT_LIMIT"
  | "OBJ_VIEWER_LINE_LIMIT"
  | "OBJ_VIEWER_POINT_LIMIT"
  | "OBJ_VIEWER_METADATA_LIMIT"
  | "OBJ_VIEWER_NO_RENDERABLE_GEOMETRY"
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
  | "GLB_VIEWER_SEGMENT_LIMIT"
  | "GLB_VIEWER_MATERIAL_LIMIT"
  | "GLB_VIEWER_TEXTURE_LIMIT"
  | "GLB_VIEWER_IMAGE_LIMIT"
  | "GLB_VIEWER_METADATA_LIMIT"
  | "GLB_VIEWER_NO_RENDERABLE_GEOMETRY"
  | "GLB_IMAGE_REFERENCE_INVALID"
  | "GLB_IMAGE_MIME_UNSUPPORTED"
  | "GLB_IMAGE_DECODE_FAILED"
  | "GLB_TEXTURE_REFERENCE_INVALID"
  | "GLB_MATERIAL_REFERENCE_INVALID"
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
  | "PLY_VIEWER_EDGE_LIMIT"
  | "PLY_VIEWER_POINT_LIMIT"
  | "PLY_VIEWER_NO_RENDERABLE_GEOMETRY"
  | "FBX_FILE_TOO_LARGE"
  | "FBX_HEADER_TRUNCATED"
  | "FBX_MAGIC_INVALID"
  | "FBX_ASCII_DETECTED"
  | "FBX_VERSION_UNSUPPORTED"
  | "FBX_NODE_TRUNCATED"
  | "FBX_NODE_COUNT_EXCEEDED"
  | "FBX_NODE_DEPTH_EXCEEDED"
  | "FBX_PROPERTY_COUNT_EXCEEDED"
  | "FBX_PROPERTY_INVALID"
  | "FBX_STRING_TOO_LONG"
  | "FBX_RAW_PROPERTY_TOO_LARGE"
  | "FBX_ARRAY_TOO_LARGE"
  | "FBX_ARRAY_COMPRESSED_TOO_LARGE"
  | "FBX_ARRAY_DECOMPRESSION_FAILED"
  | "FBX_UNSAFE_INTEGER"
  | "FBX_OFFSET_INVALID"
  | "FBX_DOCUMENT_INVALID"
  | "FBX_OBJECT_ID_DUPLICATE"
  | "FBX_OBJECT_COUNT_EXCEEDED"
  | "FBX_CONNECTION_COUNT_EXCEEDED"
  | "FBX_HIERARCHY_CYCLE"
  | "FBX_HIERARCHY_DEPTH_EXCEEDED"
  | "FBX_MODEL_COUNT_EXCEEDED"
  | "FBX_GEOMETRY_COUNT_EXCEEDED"
  | "FBX_GEOMETRY_INVALID"
  | "FBX_NON_FINITE_VERTEX"
  | "FBX_CONTROL_POINT_LIMIT_EXCEEDED"
  | "FBX_POLYGON_TOO_SMALL"
  | "FBX_POLYGON_INDEX_OUT_OF_RANGE"
  | "FBX_POLYGON_VERTEX_LIMIT_EXCEEDED"
  | "FBX_POLYGON_COUNT_EXCEEDED"
  | "FBX_TRIANGLE_LIMIT_EXCEEDED"
  | "FBX_TRANSFORM_INVALID"
  | "FBX_MATERIAL_COUNT_EXCEEDED"
  | "FBX_TEXTURE_COUNT_EXCEEDED"
  | "FBX_IMAGE_COUNT_EXCEEDED"
  | "FBX_IMAGE_TOO_LARGE"
  | "FBX_METADATA_LIMIT_EXCEEDED"
  | "FBX_VIEWER_NO_RENDERABLE_GEOMETRY"
  | "FBX_OUTPUT_TOO_LARGE"
  | "VIEWER_FORMAT_UNKNOWN"
  | "VIEWER_FORMAT_AMBIGUOUS"
  | "VIEWER_DETECTION_LIMIT_EXCEEDED"
  | "VIEWER_ADAPTER_UNAVAILABLE"
  | "VIEWER_ADAPTER_LOAD_FAILED"
  | "STLDIAG_VERTEX_LIMIT_EXCEEDED"
  | "STLDIAG_EDGE_LIMIT_EXCEEDED"
  | "STLDIAG_ANALYSIS_BUDGET_EXCEEDED"
  | "STLREPAIR_INVALID_SETTINGS"
  | "STLREPAIR_UNSAFE_TOLERANCE"
  | "STLREPAIR_WELD_LIMIT_EXCEEDED"
  | "STLREPAIR_NO_VALID_TRIANGLES"
  | "STLREPAIR_PLANNING_FAILED"
  | "STLREPAIR_HOLE_FILL_REJECTED"
  | "STLREPAIR_TRIANGULATION_FAILED"
  | "STLREPAIR_TOPOLOGY_LIMIT_EXCEEDED"
  | "STLREPAIR_OUTPUT_SIZE_LIMIT_EXCEEDED"
  | "STLREPAIR_SERIALIZATION_FAILED"
  | "STLREPAIR_OUTPUT_REPARSE_FAILED"
  | "STLREPAIR_VERIFICATION_FAILED"
  | "STLOPT_INVALID_SETTINGS"
  | "STLOPT_INVALID_TARGET"
  | "STLOPT_NO_VALID_TRIANGLES"
  | "STLOPT_UNSAFE_TO_SIMPLIFY"
  | "STLOPT_PLANNING_FAILED"
  | "STLOPT_TOPOLOGY_LIMIT_EXCEEDED"
  | "STLOPT_CANDIDATE_LIMIT_EXCEEDED"
  | "STLOPT_OUTPUT_SIZE_LIMIT_EXCEEDED"
  | "STLOPT_SERIALIZATION_FAILED"
  | "STLOPT_OUTPUT_REPARSE_FAILED"
  | "STLOPT_VERIFICATION_FAILED"
  | "GCODE_EMPTY_FILE"
  | "GCODE_FILE_READ_FAILED"
  | "BATCH_ENTITLEMENT_REQUIRED"
  | "BATCH_QUEUE_FULL"
  | "BATCH_FILE_TOO_LARGE"
  | "BATCH_TOTAL_SIZE_EXCEEDED"
  | "BATCH_UNSUPPORTED_FORMAT"
  | "BATCH_DUPLICATE_FILE"
  | "BATCH_JOB_NOT_FOUND"
  | "BATCH_INVALID_TRANSITION"
  | "BATCH_MEMORY_BUDGET_EXCEEDED"
  | "BATCH_SCHEDULER_DISPOSED"
  | "BATCH_ZIP_TOO_LARGE"
  | "BATCH_ZIP_GENERATION_FAILED"
  | "BATCH_PRESET_INVALID"
  | "BATCH_PRESET_NAME_DUPLICATE"
  | "BATCH_PRESET_STORAGE_FAILED"
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
  STL_ASCII_MALFORMED: "This ASCII STL file has a formatting problem MeshWrench can't parse.",
  STL_INVALID_TRIANGLE_COUNT: "This STL file reports an impossible number of triangles.",
  STL_NON_FINITE_VERTEX: "This STL file contains invalid coordinate values.",
  STL_TOO_COMPLEX: "This model has more triangles than the free viewer currently supports.",
  STL_EMPTY_GEOMETRY: "This STL file doesn't contain any triangles.",
  STL_SERIALIZATION_FAILED: "MeshWrench couldn't build an STL file from this geometry.",
  THREEMF_INVALID_PACKAGE: "This doesn't look like a valid 3MF package.",
  THREEMF_ZIP_CORRUPT: "This 3MF file's package data is corrupted.",
  THREEMF_ZIP_ENCRYPTED: "This 3MF file is password-protected and can't be read locally.",
  THREEMF_PACKAGE_TOO_LARGE: "This 3MF file is larger than this tool currently supports.",
  THREEMF_ZIP_BOMB_SUSPECTED: "This 3MF file's compression looks suspicious and was rejected for safety.",
  THREEMF_MODEL_PART_MISSING: "MeshWrench couldn't find a 3D model inside this 3MF package.",
  THREEMF_RELATIONSHIP_INVALID: "This 3MF package's internal file relationships are invalid.",
  THREEMF_XML_MALFORMED: "This 3MF file's model data is malformed and can't be parsed.",
  THREEMF_UNIT_UNSUPPORTED: "This 3MF file declares a measurement unit MeshWrench doesn't recognize.",
  THREEMF_OBJECT_DUPLICATE: "This 3MF file has ambiguous duplicate object definitions.",
  THREEMF_OBJECT_MISSING: "This 3MF file references an object that doesn't exist.",
  THREEMF_COMPONENT_CYCLE: "This 3MF file has a circular component reference.",
  THREEMF_COMPONENT_DEPTH_EXCEEDED: "This 3MF file nests components more deeply than this tool supports.",
  THREEMF_VERTEX_INVALID: "This 3MF file contains invalid vertex data.",
  THREEMF_TRIANGLE_INVALID: "This 3MF file contains an invalid triangle reference.",
  THREEMF_BUILD_EMPTY: "This 3MF file doesn't build any visible model.",
  THREEMF_GEOMETRY_EMPTY: "This 3MF file doesn't contain any triangles to convert.",
  THREEMF_COMPLEXITY_LIMIT: "This 3MF model is more complex than this tool currently supports.",
  THREEMF_VIEWER_SEGMENT_LIMIT: "This 3MF file resolves to more build/component instances than this viewer currently supports.",
  THREEMF_VIEWER_METADATA_LIMIT: "This 3MF file's metadata exceeds this viewer's safety limit.",
  THREEMF_VIEWER_COLOR_LIMIT: "This 3MF file declares more color entries than this viewer currently supports.",
  THREEMF_VIEWER_MATERIAL_LIMIT: "This 3MF file declares more materials than this viewer currently supports.",
  THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY: "This 3MF file doesn't resolve to any renderable geometry.",
  THREEMF_COLOR_REFERENCE_INVALID: "This 3MF file declares a color value MeshWrench couldn't read.",
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
  OBJ_POLYGON_NON_PLANAR: "This OBJ file has a face that isn't flat enough for MeshWrench to convert reliably.",
  OBJ_POLYGON_SELF_INTERSECTING: "This OBJ file has a face whose edges cross themselves.",
  OBJ_TRIANGULATION_FAILED: "MeshWrench couldn't safely split one of this file's faces into triangles.",
  OBJ_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  OBJ_NO_FACE_GEOMETRY: "This OBJ file doesn't contain any face geometry to convert.",
  OBJ_NON_FINITE_COORDINATE: "This OBJ file contains an invalid coordinate value.",
  OBJ_UNSUPPORTED_GEOMETRY: "This OBJ file only contains lines or points, which STL can't represent.",
  OBJ_EMPTY_GEOMETRY: "This OBJ file doesn't contain any geometry.",
  OBJ_VIEWER_SEGMENT_LIMIT: "This OBJ file declares more objects, groups or material changes than this viewer currently supports.",
  OBJ_VIEWER_LINE_LIMIT: "This OBJ file has more line geometry than this viewer currently supports.",
  OBJ_VIEWER_POINT_LIMIT: "This OBJ file has more point geometry than this viewer currently supports.",
  OBJ_VIEWER_METADATA_LIMIT: "This OBJ file's object, group and material names exceed this viewer's metadata limit.",
  OBJ_VIEWER_NO_RENDERABLE_GEOMETRY: "This OBJ file doesn't contain any triangles, lines or points to display.",
  GLB_FILE_TOO_LARGE: "This GLB file is larger than this tool currently supports.",
  GLB_HEADER_TRUNCATED: "This file is too short to be a valid GLB file.",
  GLB_MAGIC_INVALID: "This doesn't look like a valid GLB file.",
  GLB_VERSION_UNSUPPORTED: "This GLB file uses a glTF version MeshWrench doesn't support.",
  GLB_LENGTH_INVALID: "This GLB file's declared size doesn't match its actual size.",
  GLB_CHUNK_TRUNCATED: "This GLB file's internal data is incomplete or corrupted.",
  GLB_CHUNK_INVALID: "This GLB file's internal data is structured unexpectedly.",
  GLB_JSON_CHUNK_MISSING: "This GLB file doesn't contain the required scene description.",
  GLB_JSON_INVALID: "This GLB file's scene description is malformed and can't be parsed.",
  GLB_BIN_CHUNK_MISSING: "This GLB file references binary data that isn't included in the file.",
  GLB_ASSET_INVALID: "This GLB file doesn't declare a supported glTF version.",
  GLB_EXTERNAL_BUFFER_UNSUPPORTED: "This GLB file references external data, which MeshWrench can't load locally.",
  GLB_BUFFER_INVALID: "This GLB file's binary data doesn't match its own description.",
  GLB_BUFFER_VIEW_INVALID: "This GLB file references binary data outside its own bounds.",
  GLB_ACCESSOR_INVALID: "This GLB file describes its geometry data inconsistently.",
  GLB_ACCESSOR_OUT_OF_BOUNDS: "This GLB file's geometry data extends beyond the space it's given.",
  GLB_ACCESSOR_TYPE_UNSUPPORTED: "This GLB file uses a geometry data format MeshWrench doesn't support.",
  GLB_SPARSE_ACCESSOR_INVALID: "This GLB file's sparse geometry data is invalid.",
  GLB_INDEX_INVALID: "This GLB file references a vertex that doesn't exist.",
  GLB_POSITION_MISSING: "This GLB file has a mesh with no vertex positions.",
  GLB_PRIMITIVE_MODE_UNSUPPORTED: "This GLB file uses a geometry type MeshWrench doesn't recognize.",
  GLB_SCENE_MISSING: "MeshWrench couldn't find a scene to convert in this GLB file.",
  GLB_NODE_INVALID: "This GLB file's scene structure is invalid.",
  GLB_NODE_CYCLE: "This GLB file's scene structure contains a circular reference.",
  GLB_NODE_DEPTH_EXCEEDED: "This GLB file's scene is nested more deeply than this tool supports.",
  GLB_TRANSFORM_INVALID: "This GLB file contains an invalid position, rotation or scale value.",
  GLB_EXTENSION_REQUIRED_UNSUPPORTED: "This GLB file requires a feature MeshWrench doesn't support.",
  GLB_DRACO_UNSUPPORTED: "This GLB file uses Draco mesh compression, which MeshWrench doesn't support yet.",
  GLB_MESHOPT_UNSUPPORTED: "This GLB file uses meshopt compression, which MeshWrench doesn't support yet.",
  GLB_COMPLEXITY_LIMIT: "This model is more complex than this tool currently supports.",
  GLB_EMPTY_GEOMETRY: "This GLB file doesn't contain any triangles to convert.",
  GLB_VIEWER_SEGMENT_LIMIT: "This GLB file has more mesh instances than this viewer currently supports.",
  GLB_VIEWER_MATERIAL_LIMIT: "This GLB file declares more materials than this viewer currently supports.",
  GLB_VIEWER_TEXTURE_LIMIT: "This GLB file declares more textures than this viewer currently supports.",
  GLB_VIEWER_IMAGE_LIMIT: "This GLB file's embedded images exceed this viewer's safety limit.",
  GLB_VIEWER_METADATA_LIMIT: "This GLB file's scene metadata exceeds this viewer's safety limit.",
  GLB_VIEWER_NO_RENDERABLE_GEOMETRY: "This GLB file doesn't resolve to any renderable geometry.",
  GLB_IMAGE_REFERENCE_INVALID: "This GLB file references an image that doesn't exist or is stored outside the file.",
  GLB_IMAGE_MIME_UNSUPPORTED: "This GLB file uses an embedded image format MeshWrench doesn't support.",
  GLB_IMAGE_DECODE_FAILED: "MeshWrench couldn't decode one of this file's embedded images.",
  GLB_TEXTURE_REFERENCE_INVALID: "This GLB file references a texture that doesn't exist.",
  GLB_MATERIAL_REFERENCE_INVALID: "This GLB file references a material that doesn't exist.",
  OBJ_SERIALIZATION_FAILED: "MeshWrench couldn't build an OBJ file from this geometry.",
  OBJ_OUTPUT_TOO_LARGE: "The generated OBJ file would be larger than this tool currently supports.",
  OBJ_FACE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  OBJ_NON_FINITE_OUTPUT: "MeshWrench found an invalid coordinate value while building the OBJ file.",
  OBJ_NO_OUTPUT_GEOMETRY: "This STL file has no usable triangles to convert to OBJ.",
  OBJ_TEXT_ENCODING_FAILED: "MeshWrench couldn't encode the generated OBJ file as text.",
  OBJ_INDEX_OVERFLOW: "This model has more vertices than an OBJ file can reference.",
  OBJ_UNIQUE_VERTEX_LIMIT_EXCEEDED: "This model has more unique vertices than this tool currently supports.",
  STL_TO_OBJ_DEDUPLICATION_FAILED: "MeshWrench couldn't process this model's vertex data.",
  STL_TO_OBJ_CANCELLED: "Processing was cancelled.",
  THREEMF_SERIALIZATION_FAILED: "MeshWrench couldn't build a 3MF file from this geometry.",
  THREEMF_XML_SERIALIZATION_FAILED: "MeshWrench couldn't build this model's 3MF description.",
  THREEMF_PACKAGE_WRITE_FAILED: "MeshWrench couldn't package the generated 3MF file.",
  THREEMF_OUTPUT_TOO_LARGE: "The generated 3MF file would be larger than this tool currently supports.",
  THREEMF_VERTEX_LIMIT_EXCEEDED: "This model has more unique vertices than this tool currently supports.",
  THREEMF_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  THREEMF_NON_FINITE_OUTPUT: "MeshWrench found an invalid coordinate value while building the 3MF file.",
  THREEMF_NO_OUTPUT_GEOMETRY: "This STL file has no usable triangles to convert to 3MF.",
  STL_TO_THREEMF_DEDUPLICATION_FAILED: "MeshWrench couldn't process this model's vertex data.",
  STL_TO_THREEMF_CANCELLED: "Processing was cancelled.",
  PLY_FILE_TOO_LARGE: "This PLY file is larger than this tool currently supports.",
  PLY_MAGIC_INVALID: "This doesn't look like a valid PLY file.",
  PLY_HEADER_UNTERMINATED: "This PLY file's header is incomplete or corrupted.",
  PLY_HEADER_TOO_LARGE: "This PLY file's header is larger than this tool currently supports.",
  PLY_FORMAT_MISSING: "This PLY file doesn't declare a format (ASCII or binary).",
  PLY_FORMAT_DUPLICATE: "This PLY file declares its format more than once.",
  PLY_FORMAT_UNSUPPORTED: "This PLY file uses a format or version MeshWrench doesn't support.",
  PLY_ELEMENT_INVALID: "This PLY file has a malformed element declaration.",
  PLY_ELEMENT_DUPLICATE: "This PLY file declares the same element name more than once.",
  PLY_ELEMENT_LIMIT_EXCEEDED: "This PLY file declares more elements than this tool currently supports.",
  PLY_PROPERTY_INVALID: "This PLY file has a malformed property declaration.",
  PLY_PROPERTY_BEFORE_ELEMENT: "This PLY file declares a property before any element.",
  PLY_PROPERTY_DUPLICATE: "This PLY file declares the same property name more than once on one element.",
  PLY_PROPERTY_LIMIT_EXCEEDED: "This PLY file declares more properties on one element than this tool currently supports.",
  PLY_UNKNOWN_KEYWORD: "This PLY file's header contains a line MeshWrench doesn't recognize.",
  PLY_VERTEX_ELEMENT_MISSING: "This PLY file doesn't declare a vertex element.",
  PLY_VERTEX_COORDINATE_MISSING: "This PLY file's vertex element is missing an x, y or z coordinate.",
  PLY_VERTEX_COORDINATE_TYPE_INVALID: "This PLY file declares a vertex coordinate as a list, which isn't valid.",
  PLY_FACE_ELEMENT_MISSING: "This PLY file only contains points, not faces — MeshWrench can't build a surface from points alone.",
  PLY_FACE_INDEX_PROPERTY_MISSING: "This PLY file's face element doesn't declare a vertex index list MeshWrench can use.",
  PLY_FACE_INDEX_PROPERTY_AMBIGUOUS: "This PLY file's face element declares more than one vertex index list, which is ambiguous.",
  PLY_FACE_INDEX_TYPE_INVALID: "This PLY file's face vertex index list isn't declared as an integer type.",
  PLY_BODY_TRUNCATED: "This PLY file's data is incomplete or corrupted.",
  PLY_ASCII_VALUE_INVALID: "This PLY file contains a value MeshWrench couldn't read as a number.",
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
  PLY_POLYGON_NON_PLANAR: "This PLY file has a face that isn't flat enough for MeshWrench to convert reliably.",
  PLY_POLYGON_SELF_INTERSECTING: "This PLY file has a face whose edges cross themselves.",
  PLY_TRIANGULATION_FAILED: "MeshWrench couldn't safely split one of this file's faces into triangles.",
  PLY_COMPLEXITY_LIMIT: "This model is more complex than this tool currently supports.",
  PLY_VIEWER_EDGE_LIMIT: "This PLY file has more edges than this viewer currently supports.",
  PLY_VIEWER_POINT_LIMIT: "This PLY file has more points than this viewer currently supports.",
  PLY_VIEWER_NO_RENDERABLE_GEOMETRY: "This PLY file doesn't contain any vertices to display.",
  FBX_FILE_TOO_LARGE: "This FBX file is larger than this tool currently supports.",
  FBX_HEADER_TRUNCATED: "This file is too short to be a valid FBX file.",
  FBX_MAGIC_INVALID: "This doesn't look like a valid binary FBX file.",
  FBX_ASCII_DETECTED: "This is an ASCII FBX file. MeshWrench currently only supports binary FBX files.",
  FBX_VERSION_UNSUPPORTED: "This FBX file uses a version MeshWrench doesn't support yet.",
  FBX_NODE_TRUNCATED: "This FBX file's internal data is incomplete or corrupted.",
  FBX_NODE_COUNT_EXCEEDED: "This FBX file declares more internal nodes than this tool currently supports.",
  FBX_NODE_DEPTH_EXCEEDED: "This FBX file's internal structure is nested more deeply than this tool supports.",
  FBX_PROPERTY_COUNT_EXCEEDED: "This FBX file declares more properties on one node than this tool currently supports.",
  FBX_PROPERTY_INVALID: "This FBX file contains a property type MeshWrench doesn't recognize.",
  FBX_STRING_TOO_LONG: "This FBX file contains a text value longer than this tool currently supports.",
  FBX_RAW_PROPERTY_TOO_LARGE: "This FBX file contains a binary value larger than this tool currently supports.",
  FBX_ARRAY_TOO_LARGE: "This FBX file declares an array larger than this tool currently supports.",
  FBX_ARRAY_COMPRESSED_TOO_LARGE: "This FBX file contains compressed data larger than this tool currently supports.",
  FBX_ARRAY_DECOMPRESSION_FAILED: "This FBX file's compressed data is corrupted and couldn't be read.",
  FBX_UNSAFE_INTEGER: "This FBX file contains a number too large for MeshWrench to read safely.",
  FBX_OFFSET_INVALID: "This FBX file's internal data references a position outside the file.",
  FBX_DOCUMENT_INVALID: "This FBX file's internal structure doesn't match what MeshWrench expects.",
  FBX_OBJECT_ID_DUPLICATE: "This FBX file declares the same internal object twice, which is ambiguous.",
  FBX_OBJECT_COUNT_EXCEEDED: "This FBX file declares more objects than this tool currently supports.",
  FBX_CONNECTION_COUNT_EXCEEDED: "This FBX file declares more internal connections than this tool currently supports.",
  FBX_HIERARCHY_CYCLE: "This FBX file's model hierarchy contains a circular reference.",
  FBX_HIERARCHY_DEPTH_EXCEEDED: "This FBX file's model hierarchy is nested more deeply than this tool supports.",
  FBX_MODEL_COUNT_EXCEEDED: "This FBX file declares more models than this viewer currently supports.",
  FBX_GEOMETRY_COUNT_EXCEEDED: "This FBX file declares more geometry objects than this viewer currently supports.",
  FBX_GEOMETRY_INVALID: "This FBX file describes a mesh's geometry inconsistently.",
  FBX_NON_FINITE_VERTEX: "This FBX file contains an invalid coordinate value.",
  FBX_CONTROL_POINT_LIMIT_EXCEEDED: "This FBX file has a mesh with more control points than this tool currently supports.",
  FBX_POLYGON_TOO_SMALL: "This FBX file has a polygon with fewer than three vertices.",
  FBX_POLYGON_INDEX_OUT_OF_RANGE: "This FBX file references a control point that doesn't exist.",
  FBX_POLYGON_VERTEX_LIMIT_EXCEEDED: "This FBX file has a polygon with more vertices than this tool currently supports.",
  FBX_POLYGON_COUNT_EXCEEDED: "This FBX file has a mesh with more polygons than this tool currently supports.",
  FBX_TRIANGLE_LIMIT_EXCEEDED: "This model has more triangles than this tool currently supports.",
  FBX_TRANSFORM_INVALID: "This FBX file contains an invalid position, rotation or scale value.",
  FBX_MATERIAL_COUNT_EXCEEDED: "This FBX file declares more materials than this viewer currently supports.",
  FBX_TEXTURE_COUNT_EXCEEDED: "This FBX file declares more textures than this viewer currently supports.",
  FBX_IMAGE_COUNT_EXCEEDED: "This FBX file's embedded images exceed this viewer's safety limit.",
  FBX_IMAGE_TOO_LARGE: "One of this FBX file's embedded images is larger than this viewer currently supports.",
  FBX_METADATA_LIMIT_EXCEEDED: "This FBX file's scene metadata exceeds this viewer's safety limit.",
  FBX_VIEWER_NO_RENDERABLE_GEOMETRY: "This FBX file doesn't resolve to any renderable geometry.",
  FBX_OUTPUT_TOO_LARGE: "This model is more complex than this viewer currently supports.",
  VIEWER_FORMAT_UNKNOWN: "MeshWrench couldn't confidently identify this file's 3D format. Supported formats: STL, OBJ, 3MF, GLB, PLY, and binary FBX.",
  VIEWER_FORMAT_AMBIGUOUS: "This file's content is too ambiguous to open safely. Supported formats: STL, OBJ, 3MF, GLB, PLY, and binary FBX.",
  VIEWER_DETECTION_LIMIT_EXCEEDED: "This file is too large or complex for MeshWrench to safely identify its format.",
  VIEWER_ADAPTER_UNAVAILABLE: "This format isn't available in the universal viewer yet.",
  VIEWER_ADAPTER_LOAD_FAILED: "The local viewer engine for this format couldn't be loaded.",
  STLDIAG_VERTEX_LIMIT_EXCEEDED: "This model has more unique vertex positions than this checker currently supports.",
  STLDIAG_EDGE_LIMIT_EXCEEDED: "This model has more distinct edges than this checker currently supports.",
  STLDIAG_ANALYSIS_BUDGET_EXCEEDED: "This model is too complex to fully analyze within this checker's time budget. Partial results are shown where available.",
  STLREPAIR_INVALID_SETTINGS: "These repair settings aren't valid. Adjust them and try again.",
  STLREPAIR_UNSAFE_TOLERANCE: "The welding tolerance you set is outside the safe range for this model.",
  STLREPAIR_WELD_LIMIT_EXCEEDED: "This model has more vertex-welding candidates than this tool currently supports.",
  STLREPAIR_NO_VALID_TRIANGLES: "This file has no usable triangles to repair.",
  STLREPAIR_PLANNING_FAILED: "MeshWrench couldn't build a repair plan for this file.",
  STLREPAIR_HOLE_FILL_REJECTED: "One or more holes couldn't be safely filled and were left as-is.",
  STLREPAIR_TRIANGULATION_FAILED: "A boundary loop couldn't be safely triangulated and was left as-is.",
  STLREPAIR_TOPOLOGY_LIMIT_EXCEEDED: "This model's topology is more complex than this tool currently supports.",
  STLREPAIR_OUTPUT_SIZE_LIMIT_EXCEEDED: "The repaired model would be larger than this tool currently supports.",
  STLREPAIR_SERIALIZATION_FAILED: "MeshWrench couldn't build a repaired STL file from this geometry.",
  STLREPAIR_OUTPUT_REPARSE_FAILED: "MeshWrench couldn't verify the repaired file it just built. No file was produced.",
  STLREPAIR_VERIFICATION_FAILED: "MeshWrench couldn't verify the repair results. No file was produced.",
  STLOPT_INVALID_SETTINGS: "These optimization settings aren't valid. Adjust them and try again.",
  STLOPT_INVALID_TARGET: "The requested target isn't achievable for this model. Choose a higher triangle count or a smaller reduction.",
  STLOPT_NO_VALID_TRIANGLES: "This file has no usable triangles to optimize.",
  STLOPT_UNSAFE_TO_SIMPLIFY: "This model's topology isn't safe to simplify automatically. Try STL Repair first.",
  STLOPT_PLANNING_FAILED: "MeshWrench couldn't build an optimization plan for this file.",
  STLOPT_TOPOLOGY_LIMIT_EXCEEDED: "This model's topology is more complex than this tool currently supports.",
  STLOPT_CANDIDATE_LIMIT_EXCEEDED: "This model has more simplification candidates than this tool currently supports.",
  STLOPT_OUTPUT_SIZE_LIMIT_EXCEEDED: "The optimized model would be larger than this tool currently supports.",
  STLOPT_SERIALIZATION_FAILED: "MeshWrench couldn't build an optimized STL file from this geometry.",
  STLOPT_OUTPUT_REPARSE_FAILED: "MeshWrench couldn't verify the optimized file it just built. No file was produced.",
  STLOPT_VERIFICATION_FAILED: "MeshWrench couldn't verify the optimization results. No file was produced.",
  GCODE_EMPTY_FILE: "That G-code file appears to be empty.",
  GCODE_FILE_READ_FAILED: "The file couldn't be read from your device.",
  BATCH_ENTITLEMENT_REQUIRED: "Batch processing is a Pro capability. Upgrade at /pricing/ to unlock it.",
  BATCH_QUEUE_FULL: "This batch already has the maximum number of files it can hold.",
  BATCH_FILE_TOO_LARGE: "One of these files is larger than this batch tool currently supports.",
  BATCH_TOTAL_SIZE_EXCEEDED: "Adding this file would put the batch over its total size limit.",
  BATCH_UNSUPPORTED_FORMAT: "This file's format doesn't match the selected batch operation.",
  BATCH_DUPLICATE_FILE: "This file is already in the batch.",
  BATCH_JOB_NOT_FOUND: "That file is no longer in the batch.",
  BATCH_INVALID_TRANSITION: "That action isn't available for this file's current state.",
  BATCH_MEMORY_BUDGET_EXCEEDED: "There isn't enough memory available right now to process this file safely.",
  BATCH_SCHEDULER_DISPOSED: "This batch session has ended.",
  BATCH_ZIP_TOO_LARGE: "The combined results are too large to package into one download.",
  BATCH_ZIP_GENERATION_FAILED: "MeshWrench couldn't build the ZIP download for these results.",
  BATCH_PRESET_INVALID: "That preset's settings couldn't be read.",
  BATCH_PRESET_NAME_DUPLICATE: "A preset with that name already exists.",
  BATCH_PRESET_STORAGE_FAILED: "MeshWrench couldn't save that preset to this device.",
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
  "THREEMF_VIEWER_SEGMENT_LIMIT",
  "THREEMF_VIEWER_METADATA_LIMIT",
  "THREEMF_VIEWER_COLOR_LIMIT",
  "THREEMF_VIEWER_MATERIAL_LIMIT",
  "THREEMF_VIEWER_NO_RENDERABLE_GEOMETRY",
  "THREEMF_COLOR_REFERENCE_INVALID",
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
  "OBJ_VIEWER_SEGMENT_LIMIT",
  "OBJ_VIEWER_LINE_LIMIT",
  "OBJ_VIEWER_POINT_LIMIT",
  "OBJ_VIEWER_METADATA_LIMIT",
  "OBJ_VIEWER_NO_RENDERABLE_GEOMETRY",
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
  "GLB_VIEWER_SEGMENT_LIMIT",
  "GLB_VIEWER_MATERIAL_LIMIT",
  "GLB_VIEWER_TEXTURE_LIMIT",
  "GLB_VIEWER_IMAGE_LIMIT",
  "GLB_VIEWER_METADATA_LIMIT",
  "GLB_VIEWER_NO_RENDERABLE_GEOMETRY",
  "GLB_IMAGE_REFERENCE_INVALID",
  "GLB_IMAGE_MIME_UNSUPPORTED",
  "GLB_IMAGE_DECODE_FAILED",
  "GLB_TEXTURE_REFERENCE_INVALID",
  "GLB_MATERIAL_REFERENCE_INVALID",
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
  "PLY_VIEWER_EDGE_LIMIT",
  "PLY_VIEWER_POINT_LIMIT",
  "PLY_VIEWER_NO_RENDERABLE_GEOMETRY",
  "FBX_FILE_TOO_LARGE",
  "FBX_HEADER_TRUNCATED",
  "FBX_MAGIC_INVALID",
  "FBX_ASCII_DETECTED",
  "FBX_VERSION_UNSUPPORTED",
  "FBX_NODE_TRUNCATED",
  "FBX_NODE_COUNT_EXCEEDED",
  "FBX_NODE_DEPTH_EXCEEDED",
  "FBX_PROPERTY_COUNT_EXCEEDED",
  "FBX_PROPERTY_INVALID",
  "FBX_STRING_TOO_LONG",
  "FBX_RAW_PROPERTY_TOO_LARGE",
  "FBX_ARRAY_TOO_LARGE",
  "FBX_ARRAY_COMPRESSED_TOO_LARGE",
  "FBX_ARRAY_DECOMPRESSION_FAILED",
  "FBX_UNSAFE_INTEGER",
  "FBX_OFFSET_INVALID",
  "FBX_DOCUMENT_INVALID",
  "FBX_OBJECT_ID_DUPLICATE",
  "FBX_OBJECT_COUNT_EXCEEDED",
  "FBX_CONNECTION_COUNT_EXCEEDED",
  "FBX_HIERARCHY_CYCLE",
  "FBX_HIERARCHY_DEPTH_EXCEEDED",
  "FBX_MODEL_COUNT_EXCEEDED",
  "FBX_GEOMETRY_COUNT_EXCEEDED",
  "FBX_GEOMETRY_INVALID",
  "FBX_NON_FINITE_VERTEX",
  "FBX_CONTROL_POINT_LIMIT_EXCEEDED",
  "FBX_POLYGON_TOO_SMALL",
  "FBX_POLYGON_INDEX_OUT_OF_RANGE",
  "FBX_POLYGON_VERTEX_LIMIT_EXCEEDED",
  "FBX_POLYGON_COUNT_EXCEEDED",
  "FBX_TRIANGLE_LIMIT_EXCEEDED",
  "FBX_TRANSFORM_INVALID",
  "FBX_MATERIAL_COUNT_EXCEEDED",
  "FBX_TEXTURE_COUNT_EXCEEDED",
  "FBX_IMAGE_COUNT_EXCEEDED",
  "FBX_IMAGE_TOO_LARGE",
  "FBX_METADATA_LIMIT_EXCEEDED",
  "FBX_VIEWER_NO_RENDERABLE_GEOMETRY",
  "FBX_OUTPUT_TOO_LARGE",
  "VIEWER_FORMAT_UNKNOWN",
  "VIEWER_FORMAT_AMBIGUOUS",
  "VIEWER_DETECTION_LIMIT_EXCEEDED",
  "VIEWER_ADAPTER_UNAVAILABLE",
  "VIEWER_ADAPTER_LOAD_FAILED",
  "STLDIAG_VERTEX_LIMIT_EXCEEDED",
  "STLDIAG_EDGE_LIMIT_EXCEEDED",
  "STLDIAG_ANALYSIS_BUDGET_EXCEEDED",
  "STLREPAIR_INVALID_SETTINGS",
  "STLREPAIR_UNSAFE_TOLERANCE",
  "STLREPAIR_WELD_LIMIT_EXCEEDED",
  "STLREPAIR_NO_VALID_TRIANGLES",
  "STLREPAIR_HOLE_FILL_REJECTED",
  "STLREPAIR_TRIANGULATION_FAILED",
  "STLREPAIR_TOPOLOGY_LIMIT_EXCEEDED",
  "STLREPAIR_OUTPUT_SIZE_LIMIT_EXCEEDED",
  "STLOPT_INVALID_SETTINGS",
  "STLOPT_INVALID_TARGET",
  "STLOPT_NO_VALID_TRIANGLES",
  "STLOPT_UNSAFE_TO_SIMPLIFY",
  "STLOPT_TOPOLOGY_LIMIT_EXCEEDED",
  "STLOPT_CANDIDATE_LIMIT_EXCEEDED",
  "STLOPT_OUTPUT_SIZE_LIMIT_EXCEEDED",
  "GCODE_FILE_READ_FAILED",
  "BATCH_QUEUE_FULL",
  "BATCH_FILE_TOO_LARGE",
  "BATCH_TOTAL_SIZE_EXCEEDED",
  "BATCH_UNSUPPORTED_FORMAT",
  "BATCH_DUPLICATE_FILE",
  "BATCH_MEMORY_BUDGET_EXCEEDED",
  "BATCH_ZIP_TOO_LARGE",
  "BATCH_ZIP_GENERATION_FAILED",
  "BATCH_PRESET_NAME_DUPLICATE",
  "BATCH_PRESET_STORAGE_FAILED",
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
