import { describe, expect, it } from "vitest";
import {
  createPlaybackState,
  play,
  pause,
  resume,
  restart,
  seek,
  advance,
  stepForward,
  stepBackward,
  setPlaybackRate,
  replaceMoveCount,
  teardown,
} from "./playback";

describe("createPlaybackState", () => {
  it("starts idle at move 0", () => {
    const s = createPlaybackState(100);
    expect(s.status).toBe("idle");
    expect(s.currentMoveIndex).toBe(0);
    expect(s.totalMoves).toBe(100);
    expect(s.playbackRate).toBe(1);
  });
});

describe("play / pause / resume", () => {
  it("play() transitions idle to playing", () => {
    expect(play(createPlaybackState(10)).status).toBe("playing");
  });

  it("pause() only takes effect while playing", () => {
    const playing = play(createPlaybackState(10));
    expect(pause(playing).status).toBe("paused");
    expect(pause(createPlaybackState(10)).status).toBe("idle"); // pausing while idle is a no-op
  });

  it("resume() only takes effect while paused", () => {
    const paused = pause(play(createPlaybackState(10)));
    expect(resume(paused).status).toBe("playing");
    expect(resume(createPlaybackState(10)).status).toBe("idle"); // resuming while idle is a no-op
  });

  it("play() on a completed sequence restarts it from the beginning", () => {
    let s = createPlaybackState(2);
    s = play(s);
    s = advance(s, 5); // overshoot -> complete
    expect(s.status).toBe("complete");
    s = play(s);
    expect(s.status).toBe("playing");
    expect(s.currentMoveIndex).toBe(0);
  });

  it("play() on an empty sequence (zero moves) never transitions to playing", () => {
    expect(play(createPlaybackState(0)).status).toBe("idle");
  });
});

describe("restart", () => {
  it("resets to idle at move 0 regardless of current status", () => {
    let s = play(createPlaybackState(10));
    s = advance(s, 5);
    s = restart(s);
    expect(s.status).toBe("idle");
    expect(s.currentMoveIndex).toBe(0);
  });
});

describe("seek", () => {
  it("moves to the requested index and clamps within [0, totalMoves]", () => {
    const s = createPlaybackState(100);
    expect(seek(s, 50).currentMoveIndex).toBe(50);
    expect(seek(s, -10).currentMoveIndex).toBe(0);
    expect(seek(s, 500).currentMoveIndex).toBe(100);
  });

  it("seeking to the very end transitions to complete", () => {
    expect(seek(createPlaybackState(100), 100).status).toBe("complete");
  });

  it("seeking while idle moves to paused (a scrub implies an intentional stop point)", () => {
    expect(seek(createPlaybackState(100), 50).status).toBe("paused");
  });

  it("seeking while playing keeps playing", () => {
    const playing = play(createPlaybackState(100));
    expect(seek(playing, 50).status).toBe("playing");
  });
});

describe("advance — end of file", () => {
  it("advancing past the last move stops exactly at totalMoves and marks complete", () => {
    const s = advance(play(createPlaybackState(10)), 15);
    expect(s.currentMoveIndex).toBe(10);
    expect(s.status).toBe("complete");
  });

  it("advance() is a no-op unless currently playing", () => {
    expect(advance(createPlaybackState(10), 5).currentMoveIndex).toBe(0);
  });

  it("advancing to exactly the last move deterministically reaches it", () => {
    const s = advance(play(createPlaybackState(10)), 10);
    expect(s.currentMoveIndex).toBe(10);
    expect(s.status).toBe("complete");
  });
});

describe("stepForward / stepBackward", () => {
  it("steps by exactly one move at a time", () => {
    let s = createPlaybackState(10);
    s = stepForward(s);
    expect(s.currentMoveIndex).toBe(1);
    s = stepForward(s);
    expect(s.currentMoveIndex).toBe(2);
    s = stepBackward(s);
    expect(s.currentMoveIndex).toBe(1);
  });

  it("stepBackward never goes below 0", () => {
    expect(stepBackward(createPlaybackState(10)).currentMoveIndex).toBe(0);
  });

  it("stepForward at the last move marks complete", () => {
    const s = stepForward(seek(createPlaybackState(1), 0));
    expect(s.currentMoveIndex).toBe(1);
    expect(s.status).toBe("complete");
  });
});

describe("playback-rate changes", () => {
  it("setPlaybackRate updates the rate without touching move index or status", () => {
    const playing = play(createPlaybackState(10));
    const s = setPlaybackRate(playing, 2.5);
    expect(s.playbackRate).toBe(2.5);
    expect(s.status).toBe("playing");
    expect(s.currentMoveIndex).toBe(playing.currentMoveIndex);
  });

  it("clamps an absurd or non-positive rate to a small positive floor", () => {
    expect(setPlaybackRate(createPlaybackState(10), 0).playbackRate).toBeGreaterThan(0);
    expect(setPlaybackRate(createPlaybackState(10), -5).playbackRate).toBeGreaterThan(0);
  });
});

describe("replacement while playing (a new file loaded mid-playback)", () => {
  it("resets cleanly to idle at move 0 with the new total, never leaving a stale index", () => {
    let s = play(createPlaybackState(100));
    s = advance(s, 80);
    s = replaceMoveCount(s, 20); // new, smaller file
    expect(s.status).toBe("idle");
    expect(s.currentMoveIndex).toBe(0);
    expect(s.totalMoves).toBe(20);
  });

  it("preserves the user's chosen playback rate across a replacement", () => {
    let s = setPlaybackRate(createPlaybackState(100), 3);
    s = replaceMoveCount(s, 50);
    expect(s.playbackRate).toBe(3);
  });
});

describe("page teardown", () => {
  it("resets to a safe empty idle state", () => {
    const s = teardown();
    expect(s.status).toBe("idle");
    expect(s.currentMoveIndex).toBe(0);
    expect(s.totalMoves).toBe(0);
  });
});
