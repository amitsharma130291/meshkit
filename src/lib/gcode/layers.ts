/**
 * Layer detection: prefers trustworthy explicit slicer layer markers
 * (`comments.ts`'s own `layerMarker` signal, which covers Cura's
 * `;LAYER:n`, PrusaSlicer/OrcaSlicer's `;LAYER_CHANGE`, and Bambu
 * Studio's `;CHANGE_LAYER` uniformly). Real files in this project's
 * supported dialect scope usually mark every layer consistently — a file
 * whose ONLY explicit territory is contiguous (nothing extrudes before
 * the first marker or after the last one) is reported as fully
 * `"explicit"`. `"mixed"` is a REAL, reachable state: when genuine
 * extrusion happens before the first marker or after the last one, that
 * territory is inferred exactly the way a marker-free file would be
 * (same Z-hop immunity, same non-planar detection) and stitched onto the
 * explicit layers, sequentially renumbered by file position — never by
 * whatever index a marker itself declared, since combining two numbering
 * sources under one marker-declared scheme would be ambiguous. A
 * conflicting explicit marker index (e.g. out of monotonic order) is
 * always trusted as declared, never silently corrected — this module's
 * only job is to report what the file said, not to guess a "more
 * correct" number. If the un-marked territory turns out to be
 * non-planar (spiral/vase-like), it contributes NO layers at all rather
 * than fabricating discrete ones — the file falls back to whatever
 * explicit layers exist, with a disclosure note.
 *
 * Inference only ever looks at EXTRUSION-category moves' own Z — a
 * travel or Z-only move (a Z-hop) never starts a false layer, since its
 * Z is never even considered. A near-continuous Z change on almost every
 * extrusion move (spiral/vase printing) is recognized as non-planar and
 * is deliberately never reported as conventional discrete layers.
 */
import type { SlicerCommentSignal } from "./comments";
import type { MoveCategory } from "./linear-moves";

export type LayerSource = "explicit" | "inferred";
export type LayerDetectionMode = "explicit" | "inferred" | "mixed" | "unknown";

export interface DetectedLayer {
  index: number;
  z: number | null;
  height: number | null;
  startLineIndex: number;
  source: LayerSource;
}

export interface LayerLineEvent {
  lineIndex: number;
  commentSignal: SlicerCommentSignal | null;
  moveZ: number | null;
  moveCategory: MoveCategory | null;
}

export interface LayerDetectionResult {
  layers: DetectedLayer[];
  mode: LayerDetectionMode;
  nonPlanarDetected: boolean;
  note: string | null;
}

export const DEFAULT_Z_TOLERANCE = 1e-4;
/** If a "new layer" would be started on more than this fraction of extrusion moves, the Z path is non-planar (spiral/vase), not discrete layers. */
const VASE_MODE_RATIO_THRESHOLD = 0.8;
const MIN_MOVES_FOR_VASE_CHECK = 10;

function detectExplicit(events: readonly LayerLineEvent[]): DetectedLayer[] {
  const layers: DetectedLayer[] = [];
  let nextIndex = 0;
  let current: DetectedLayer | null = null;

  for (const event of events) {
    const signal = event.commentSignal;
    if (!signal) continue;

    if (signal.layerMarker) {
      const index = signal.layerIndex ?? nextIndex;
      current = { index, z: signal.layerZ, height: signal.layerHeight, startLineIndex: event.lineIndex, source: "explicit" };
      layers.push(current);
      nextIndex = index + 1;
      continue;
    }

    if (current) {
      if (signal.layerZ !== null) current.z = signal.layerZ;
      if (signal.layerHeight !== null) current.height = signal.layerHeight;
    }
  }

  return layers;
}

const NON_PLANAR_NOTE =
  "This file's Z height changes on nearly every extrusion move (consistent with spiral/vase printing) — MeshWrench doesn't claim conventional discrete layers for a path like this.";

/** `seedZ` lets a trailing region continue counting from the last Z an earlier (explicit) region already established, so a same-height continuation never starts a spurious duplicate layer. */
function detectInferred(
  events: readonly LayerLineEvent[],
  zTolerance: number,
  seedZ: number | null = null,
): { layers: DetectedLayer[]; nonPlanarDetected: boolean } {
  const layers: DetectedLayer[] = [];
  let currentZ: number | null = seedZ;
  let extrusionMoveCount = 0;
  let newLayerStarts = 0;

  for (const event of events) {
    if (event.moveCategory !== "extrusion" || event.moveZ === null) continue;
    extrusionMoveCount++;

    if (currentZ === null || event.moveZ > currentZ + zTolerance) {
      const previousZ = layers.length > 0 ? layers[layers.length - 1].z : seedZ;
      const height = previousZ !== null ? event.moveZ - previousZ : null;
      layers.push({ index: layers.length, z: event.moveZ, height, startLineIndex: event.lineIndex, source: "inferred" });
      currentZ = event.moveZ;
      newLayerStarts++;
    }
  }

  const nonPlanarDetected = extrusionMoveCount >= MIN_MOVES_FOR_VASE_CHECK && newLayerStarts / extrusionMoveCount > VASE_MODE_RATIO_THRESHOLD;
  return { layers, nonPlanarDetected };
}

/** Renumbers a combined layer list sequentially by file position — never by whatever index an explicit marker itself declared, since stitching two numbering sources under one marker-declared scheme would be ambiguous. Only applied when regions were actually combined (`"mixed"`); a purely `"explicit"` file keeps each marker's own declared index untouched. */
function renumberSequentially(layers: readonly DetectedLayer[]): DetectedLayer[] {
  return layers.map((layer, index) => ({ ...layer, index }));
}

export function detectLayers(events: readonly LayerLineEvent[], zTolerance: number = DEFAULT_Z_TOLERANCE): LayerDetectionResult {
  const markerLineIndices = events.filter((e) => e.commentSignal?.layerMarker).map((e) => e.lineIndex);

  if (markerLineIndices.length === 0) {
    const { layers, nonPlanarDetected } = detectInferred(events, zTolerance);

    if (nonPlanarDetected) {
      return { layers: [], mode: "unknown", nonPlanarDetected: true, note: NON_PLANAR_NOTE };
    }
    if (layers.length === 0) {
      return { layers: [], mode: "unknown", nonPlanarDetected: false, note: null };
    }
    return { layers, mode: "inferred", nonPlanarDetected: false, note: null };
  }

  const firstMarkerLine = markerLineIndices[0];
  const lastMarkerLine = markerLineIndices[markerLineIndices.length - 1];

  const explicitLayers = detectExplicit(events);
  const leadingEvents = events.filter((e) => e.lineIndex < firstMarkerLine);
  const trailingEvents = events.filter((e) => e.lineIndex > lastMarkerLine);

  // The last explicit layer's own EFFECTIVE Z: its declared Z:/HEIGHT: comment
  // if it has one, else the Z of its own first extrusion move (found by
  // scanning FORWARD from the marker) — never a Z from a PRIOR layer, which
  // would make that first move look like a spurious new layer.
  const declaredLastExplicitZ = explicitLayers.length > 0 ? explicitLayers[explicitLayers.length - 1].z : null;
  const lastExplicitZ = declaredLastExplicitZ ?? firstExtrusionZ(trailingEvents);

  const leading = detectInferred(leadingEvents, zTolerance);
  const trailing = detectInferred(trailingEvents, zTolerance, lastExplicitZ);

  const anyNonPlanarExcluded = leading.nonPlanarDetected || trailing.nonPlanarDetected;
  const leadingLayers = leading.nonPlanarDetected ? [] : leading.layers;
  const trailingLayers = trailing.nonPlanarDetected ? [] : trailing.layers;
  const note = anyNonPlanarExcluded ? NON_PLANAR_NOTE : null;

  const combined = [...leadingLayers, ...explicitLayers, ...trailingLayers];
  const wasMixed = leadingLayers.length > 0 || trailingLayers.length > 0;

  if (!wasMixed) {
    return { layers: explicitLayers, mode: "explicit", nonPlanarDetected: false, note };
  }

  return { layers: renumberSequentially(combined), mode: "mixed", nonPlanarDetected: false, note };
}

function firstExtrusionZ(events: readonly LayerLineEvent[]): number | null {
  for (const event of events) {
    if (event.moveCategory === "extrusion" && event.moveZ !== null) return event.moveZ;
  }
  return null;
}
