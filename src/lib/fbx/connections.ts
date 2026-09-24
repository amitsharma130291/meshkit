/**
 * Resolves FBX's ID-based connection graph — the `Connections` section
 * only ever says "object A connects to object B" (or "object A connects
 * to a named property on object B"), with no guarantee of declaration
 * order relative to `Objects`, and no inherent tree structure. This
 * module builds the lookups every higher layer needs (which objects are
 * attached to which Model, and the validated Model parent/child tree
 * itself) entirely from those tuples — never assuming `Objects` and
 * `Connections` appear in any particular relative order.
 */
import { fbxError } from "./errors";
import type { FBXConnection, FBXInterpretedDocument, FBXObjectId, FBXRawObject } from "./document";
import type { FBXLimits } from "./types";

/** FBX's own convention: a connection whose parent id is 0 means "the implicit scene root," not a real object. */
export const FBX_ROOT_ID: FBXObjectId = 0n;

export interface FBXConnectionGraph {
  objectById: Map<FBXObjectId, FBXRawObject>;
  /** parentId -> ids of every object OO-connected to it as a child. */
  childrenOf: Map<FBXObjectId, FBXObjectId[]>;
  /** childId -> ids of every object it's OO-connected to as a parent, in file order. */
  parentsOf: Map<FBXObjectId, FBXObjectId[]>;
  /** OP connections, kept as a flat list — mainly used to link an embedded Video to the Texture property that references it when an exporter used OP rather than OO for that link. */
  propertyConnections: FBXConnection[];
  /** Object ids with more than one OO "structural" parent candidate (another Model, or root) — the first is used, per this phase's "warn, use the first" policy for unsupported multi-parent inheritance. */
  multiParentObjectIds: Set<FBXObjectId>;
  danglingConnectionCount: number;
}

function pushInto<K>(map: Map<K, FBXObjectId[]>, key: K, value: FBXObjectId): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildConnectionGraph(doc: FBXInterpretedDocument): FBXConnectionGraph {
  const objectById = new Map<FBXObjectId, FBXRawObject>();
  for (const obj of doc.objects) objectById.set(obj.id, obj);

  const childrenOf = new Map<FBXObjectId, FBXObjectId[]>();
  const parentsOf = new Map<FBXObjectId, FBXObjectId[]>();
  const propertyConnections: FBXConnection[] = [];
  let danglingConnectionCount = 0;

  for (const conn of doc.connections) {
    if (conn.kind === "OP") {
      propertyConnections.push(conn);
      continue;
    }
    const parentExists = conn.parentId === FBX_ROOT_ID || objectById.has(conn.parentId);
    const childExists = objectById.has(conn.childId);
    if (!parentExists || !childExists) {
      danglingConnectionCount++;
      continue; // a dangling reference is common and benign (e.g. a connection to an object type this viewer never stores) — skip, don't fail the file
    }
    pushInto(childrenOf, conn.parentId, conn.childId);
    pushInto(parentsOf, conn.childId, conn.parentId);
  }

  const multiParentObjectIds = new Set<FBXObjectId>();
  for (const [childId, parents] of parentsOf) {
    const structuralCandidates = parents.filter((p) => p === FBX_ROOT_ID || objectById.get(p)?.fbxClass === "Model");
    if (structuralCandidates.length > 1) multiParentObjectIds.add(childId);
  }

  return { objectById, childrenOf, parentsOf, propertyConnections, multiParentObjectIds, danglingConnectionCount };
}

export interface FBXModelTreeNode {
  object: FBXRawObject;
  children: FBXModelTreeNode[];
}

/** The first OO parent candidate that's either the scene root or another Model — see `multiParentObjectIds` for when there was more than one such candidate to choose from. */
function structuralParentOf(graph: FBXConnectionGraph, id: FBXObjectId): FBXObjectId | null {
  const parents = graph.parentsOf.get(id);
  if (!parents) return null;
  for (const p of parents) {
    if (p === FBX_ROOT_ID) return FBX_ROOT_ID;
    if (graph.objectById.get(p)?.fbxClass === "Model") return p;
  }
  return null;
}

/** Walks the Model objects into a validated tree — cycle-free, depth-bounded. A Model with no resolvable structural parent (including one whose only parent is a non-Model, non-root object) becomes a root, same as one explicitly parented to id 0. */
export function resolveModelHierarchy(graph: FBXConnectionGraph, limits: FBXLimits): FBXModelTreeNode[] {
  const models = [...graph.objectById.values()].filter((o) => o.fbxClass === "Model");
  const childrenByParent = new Map<FBXObjectId, FBXObjectId[]>();
  const roots: FBXObjectId[] = [];

  for (const model of models) {
    const parent = structuralParentOf(graph, model.id);
    if (parent === null || parent === FBX_ROOT_ID) {
      roots.push(model.id);
    } else {
      pushInto(childrenByParent, parent, model.id);
    }
  }

  const visited = new Set<FBXObjectId>();

  const build = (id: FBXObjectId, depth: number, ancestry: ReadonlySet<FBXObjectId>): FBXModelTreeNode => {
    if (depth > limits.maxHierarchyDepth) throw fbxError("FBX_HIERARCHY_DEPTH_EXCEEDED");
    if (ancestry.has(id)) throw fbxError("FBX_HIERARCHY_CYCLE");
    const object = graph.objectById.get(id);
    if (!object) throw fbxError("FBX_DOCUMENT_INVALID");

    visited.add(id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);
    const childIds = childrenByParent.get(id) ?? [];
    return {
      object,
      children: childIds.map((childId) => build(childId, depth + 1, nextAncestry)),
    };
  };

  const tree = roots.map((id) => build(id, 0, new Set()));

  // Any Model never reached from a root has a structural parent chain that
  // never terminates at the scene root — the only way that can happen is a
  // cycle entirely disconnected from every root, which the ancestry check
  // above can't see since it's never entered from that direction.
  for (const model of models) {
    if (!visited.has(model.id)) throw fbxError("FBX_HIERARCHY_CYCLE");
  }

  return tree;
}

/** Every object OO-connected to `parentId` whose class is `fbxClass` — e.g. every Geometry attached to a Model, or every Material attached to a Model. Order matches `Connections` declaration order. */
export function connectedObjectsOfClass(graph: FBXConnectionGraph, parentId: FBXObjectId, fbxClass: string): FBXRawObject[] {
  const childIds = graph.childrenOf.get(parentId) ?? [];
  const result: FBXRawObject[] = [];
  for (const childId of childIds) {
    const obj = graph.objectById.get(childId);
    if (obj && obj.fbxClass === fbxClass) result.push(obj);
  }
  return result;
}
