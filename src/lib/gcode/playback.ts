/**
 * Pure playback state machine — no Three.js, no timers. This is VISUAL
 * playback only, never a firmware/motion simulator: it just tracks which
 * move index the viewer should currently be drawing up to, and the
 * player-controlled speed multiplier used to advance it. The renderer
 * reads `currentMoveIndex` to set a WebGL draw range; nothing here
 * touches geometry directly.
 */

export type PlaybackStatus = "idle" | "playing" | "paused" | "complete";

export interface PlaybackState {
  status: PlaybackStatus;
  currentMoveIndex: number;
  totalMoves: number;
  playbackRate: number;
}

const MIN_PLAYBACK_RATE = 0.01;

export function createPlaybackState(totalMoves: number): PlaybackState {
  return { status: "idle", currentMoveIndex: 0, totalMoves, playbackRate: 1 };
}

export function play(state: PlaybackState): PlaybackState {
  if (state.totalMoves === 0) return state;
  if (state.status === "complete") return { ...state, status: "playing", currentMoveIndex: 0 };
  return { ...state, status: "playing" };
}

export function pause(state: PlaybackState): PlaybackState {
  if (state.status !== "playing") return state;
  return { ...state, status: "paused" };
}

export function resume(state: PlaybackState): PlaybackState {
  if (state.status !== "paused") return state;
  return { ...state, status: "playing" };
}

export function restart(state: PlaybackState): PlaybackState {
  return { ...state, status: "idle", currentMoveIndex: 0 };
}

export function seek(state: PlaybackState, moveIndex: number): PlaybackState {
  const clamped = Math.max(0, Math.min(moveIndex, state.totalMoves));
  if (clamped >= state.totalMoves) return { ...state, currentMoveIndex: clamped, status: "complete" };
  const status = state.status === "playing" ? "playing" : "paused";
  return { ...state, currentMoveIndex: clamped, status };
}

/** Advances by `moveCount` moves — a no-op unless currently playing. The caller multiplies its own per-frame move budget by `playbackRate` before calling this; this function itself is rate-agnostic. */
export function advance(state: PlaybackState, moveCount: number): PlaybackState {
  if (state.status !== "playing") return state;
  const next = state.currentMoveIndex + moveCount;
  if (next >= state.totalMoves) return { ...state, currentMoveIndex: state.totalMoves, status: "complete" };
  return { ...state, currentMoveIndex: next };
}

export function stepForward(state: PlaybackState): PlaybackState {
  const next = Math.min(state.currentMoveIndex + 1, state.totalMoves);
  const status = next >= state.totalMoves ? "complete" : state.status === "playing" ? "playing" : "paused";
  return { ...state, currentMoveIndex: next, status };
}

export function stepBackward(state: PlaybackState): PlaybackState {
  const next = Math.max(state.currentMoveIndex - 1, 0);
  const status = state.status === "complete" ? "paused" : state.status;
  return { ...state, currentMoveIndex: next, status };
}

export function setPlaybackRate(state: PlaybackState, rate: number): PlaybackState {
  return { ...state, playbackRate: Math.max(MIN_PLAYBACK_RATE, rate) };
}

/** A new file was loaded while the player was in any state — always resets cleanly to idle at move 0 under the new total, never leaving an index that could point past the new file's bounds. The user's own chosen playback rate is preserved. */
export function replaceMoveCount(state: PlaybackState, totalMoves: number): PlaybackState {
  return { status: "idle", currentMoveIndex: 0, totalMoves, playbackRate: state.playbackRate };
}

/** Page/component teardown — returns a safe, empty idle state. Disposing any Three.js resources is the caller's own separate responsibility. */
export function teardown(): PlaybackState {
  return createPlaybackState(0);
}
