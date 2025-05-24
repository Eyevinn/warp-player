import { TrackAliasRegistry } from "./trackaliasregistry";

describe("TrackAliasRegistry", () => {
  let registry: TrackAliasRegistry;

  beforeEach(() => {
    registry = new TrackAliasRegistry();
  });

  test("should register a track and return a unique alias", () => {
    const alias1 = registry.registerTrack("test-namespace", "track1", 1n);
    const alias2 = registry.registerTrack("test-namespace", "track2", 2n);

    expect(alias1).toBe(1n);
    expect(alias2).toBe(2n);
  });

  test("should return the same alias for the same namespace+trackName", () => {
    const alias1 = registry.registerTrack("test-namespace", "track1", 1n);
    const alias2 = registry.registerTrack("test-namespace", "track1", 1n);

    expect(alias1).toBe(alias2);
  });

  test("should get track info from namespace+trackName", () => {
    const alias = registry.registerTrack("test-namespace", "track1", 1n);
    const info = registry.getTrackInfoFromName("test-namespace", "track1");

    expect(info).toBeDefined();
    expect(info?.namespace).toBe("test-namespace");
    expect(info?.trackName).toBe("track1");
    expect(info?.trackAlias).toBe(alias);
    expect(info?.callbacks).toEqual([]);
  });

  test("should get track info from trackAlias", () => {
    const alias = registry.registerTrack("test-namespace", "track1", 1n);
    const info = registry.getTrackInfoFromAlias(alias);

    expect(info).toBeDefined();
    expect(info?.namespace).toBe("test-namespace");
    expect(info?.trackName).toBe("track1");
    expect(info?.trackAlias).toBe(alias);
    expect(info?.callbacks).toEqual([]);
  });

  test("should register callbacks for a track", () => {
    const alias = registry.registerTrack("test-namespace", "track1", 1n);
    const callback1 = jest.fn();
    const callback2 = jest.fn();

    registry.registerCallback(alias, callback1);
    registry.registerCallback(alias, callback2);

    const callbacks = registry.getCallbacks(alias);
    expect(callbacks).toHaveLength(2);
    expect(callbacks).toContain(callback1);
    expect(callbacks).toContain(callback2);
  });

  test("should unregister callbacks for a track", () => {
    const alias = registry.registerTrack("test-namespace", "track1", 1n);
    const callback1 = jest.fn();
    const callback2 = jest.fn();

    registry.registerCallback(alias, callback1);
    registry.registerCallback(alias, callback2);
    registry.unregisterCallback(alias, callback1);

    const callbacks = registry.getCallbacks(alias);
    expect(callbacks).toHaveLength(1);
    expect(callbacks).toContain(callback2);
    expect(callbacks).not.toContain(callback1);
  });

  test("should handle unknown track alias gracefully", () => {
    const callback = jest.fn();
    const unknownAlias = 999n;

    // These should not throw errors
    registry.registerCallback(unknownAlias, callback);
    registry.unregisterCallback(unknownAlias, callback);

    const callbacks = registry.getCallbacks(unknownAlias);
    expect(callbacks).toEqual([]);
  });

  test("should clear all registrations", () => {
    registry.registerTrack("test-namespace", "track1", 1n);
    registry.registerTrack("test-namespace", "track2", 2n);

    registry.clear();

    expect(
      registry.getTrackInfoFromName("test-namespace", "track1")
    ).toBeUndefined();
    expect(
      registry.getTrackInfoFromName("test-namespace", "track2")
    ).toBeUndefined();

    // After clearing, should start with fresh aliases
    const newAlias = registry.registerTrack("test-namespace", "track3", 3n);
    expect(newAlias).toBe(1n);
  });
});
