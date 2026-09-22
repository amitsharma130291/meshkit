/**
 * The lifecycle every future tool page (viewer, converter, diagnostic,
 * repair, optimizer) is expected to move through. Not every tool will use
 * every state, but the layout and status components are built against
 * this shared vocabulary so tools stay visually and behaviorally
 * consistent.
 */
export type ToolState =
  | "idle"
  | "file-selected"
  | "initializing"
  | "processing"
  | "success"
  | "cancelled"
  | "unsupported"
  | "error";

export const TOOL_STATE_LABELS: Record<ToolState, string> = {
  idle: "Waiting for a file",
  "file-selected": "File selected",
  initializing: "Starting local processing",
  processing: "Processing",
  success: "Done",
  cancelled: "Cancelled",
  unsupported: "Unsupported",
  error: "Error",
};
