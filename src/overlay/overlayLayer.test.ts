import {
  CueChannelImpl,
  SnapshotTimeline,
  StateChannelImpl,
} from "./overlayLayer";

describe("SnapshotTimeline", () => {
  it("resolves the latest point at or before the playhead", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(1000, "a");
    timeline.set(2000, "b");
    timeline.set(3000, "c");

    expect(timeline.resolve(999)).toBeNull();
    expect(timeline.resolve(1000)).toBe("a"); // boundary is inclusive
    expect(timeline.resolve(1999)).toBe("a");
    expect(timeline.resolve(2000)).toBe("b");
    expect(timeline.resolve(9999)).toBe("c");
  });

  it("keeps points ordered regardless of insertion order", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(3000, "c");
    timeline.set(1000, "a");
    timeline.set(2000, "b");
    expect(timeline.resolve(2500)).toBe("b");
    expect(timeline.resolve(1500)).toBe("a");
    expect(timeline.size).toBe(3);
  });

  it("replaces rather than duplicates a point at the same time", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(1000, "a");
    timeline.set(1000, "a2");
    expect(timeline.size).toBe(1);
    expect(timeline.resolve(1000)).toBe("a2");
  });

  it("resolves by search, so a backwards jump needs no special case", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    for (let t = 0; t < 10_000; t += 1000) {
      timeline.set(t, `s${t}`);
    }
    // Walk forward, jump back, walk forward again — every answer is exact.
    expect(timeline.resolve(8500)).toBe("s8000");
    expect(timeline.resolve(1500)).toBe("s1000");
    expect(timeline.resolve(0)).toBe("s0");
    expect(timeline.resolve(9999)).toBe("s9000");
  });

  it("resolves to the empty state when there is no picture yet", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(1000, "a");
    expect(timeline.resolve(null)).toBeNull();
    expect(timeline.resolve(NaN)).toBeNull();
  });

  it("retains the active point plus everything after it", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(0, "a");
    timeline.set(1000, "b");
    timeline.set(2000, "c");
    timeline.set(3000, "d");

    timeline.prune(2500);
    // "c" is active at 2500 and must survive along with the future "d".
    expect(timeline.size).toBe(2);
    expect(timeline.resolve(2500)).toBe("c");
    expect(timeline.resolve(3000)).toBe("d");
    // Everything before the active point is gone.
    expect(timeline.resolve(0)).toBeNull();
  });

  it("does not prune without a clock", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(0, "a");
    timeline.set(1000, "b");
    timeline.prune(null);
    expect(timeline.size).toBe(2);
  });

  it("ignores non-finite times", () => {
    const timeline = new SnapshotTimeline<string | null>(null);
    timeline.set(NaN, "a");
    timeline.set(Infinity, "b");
    expect(timeline.size).toBe(0);
  });
});

describe("StateChannelImpl", () => {
  it("supersedes the previous payload from the push time onward", () => {
    const channel = new StateChannelImpl<string>();
    channel.push(1000, "screen-1");
    channel.push(2000, "screen-2");

    expect(channel.mode).toBe("state");
    expect(channel.resolve(500)).toBeNull();
    expect(channel.resolve(1500)).toBe("screen-1");
    expect(channel.resolve(2500)).toBe("screen-2");
  });

  it("clears the overlay on a null push", () => {
    const channel = new StateChannelImpl<string>();
    channel.push(1000, "screen-1");
    channel.push(2000, null);
    expect(channel.resolve(1999)).toBe("screen-1");
    expect(channel.resolve(2000)).toBeNull();
  });

  it("drops everything on clear()", () => {
    const channel = new StateChannelImpl<string>();
    channel.push(1000, "screen-1");
    channel.clear();
    expect(channel.size).toBe(0);
    expect(channel.resolve(5000)).toBeNull();
  });
});

describe("CueChannelImpl", () => {
  it("resolves a single cue over its interval only", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(1000, 2000, "one");

    expect(channel.mode).toBe("cues");
    expect(channel.resolve(999)).toEqual([]);
    expect(channel.resolve(1000)).toEqual(["one"]);
    expect(channel.resolve(1999)).toEqual(["one"]);
    expect(channel.resolve(2000)).toEqual([]);
  });

  it("composes overlapping cues into the active set, ordered by start", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(1000, 3000, "a");
    channel.addCue(2000, 4000, "b");

    expect(channel.resolve(1500)).toEqual(["a"]);
    expect(channel.resolve(2500)).toEqual(["a", "b"]);
    expect(channel.resolve(3500)).toEqual(["b"]);
    expect(channel.resolve(4000)).toEqual([]);
  });

  it("composes cues added out of order", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(2000, 4000, "b");
    channel.addCue(1000, 3000, "a");
    expect(channel.resolve(2500)).toEqual(["a", "b"]);
  });

  it("returns a reference-stable set inside one interval", () => {
    // The layer decides "changed" by reference, so a stable interval must
    // not produce a new array on every tick.
    const channel = new CueChannelImpl<string>();
    channel.addCue(1000, 2000, "one");
    expect(channel.resolve(1200)).toBe(channel.resolve(1800));
  });

  it("ignores degenerate and non-finite cues", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(1000, 1000, "zero-length");
    channel.addCue(2000, 1000, "reversed");
    channel.addCue(NaN, 1000, "nan");
    expect(channel.size).toBe(0);
  });

  it("retains cues active now or later, drops the rest", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(0, 1000, "past");
    channel.addCue(1000, 3000, "active");
    channel.addCue(5000, 6000, "future");

    channel.prune(2000);
    expect(channel.size).toBe(2);
    expect(channel.resolve(2000)).toEqual(["active"]);
    expect(channel.resolve(5500)).toEqual(["future"]);
  });

  it("drops everything on clear()", () => {
    const channel = new CueChannelImpl<string>();
    channel.addCue(1000, 2000, "one");
    channel.clear();
    expect(channel.size).toBe(0);
    expect(channel.resolve(1500)).toEqual([]);
  });
});
