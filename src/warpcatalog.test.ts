import {
  CTA608_ACCESSIBILITY_SCHEME,
  MSF_SUPPORTED_VERSIONS,
  WarpCatalog,
  WarpCatalogManager,
  trackHasCta608,
} from "./warpcatalog";

describe("WarpCatalogManager draft-01 init data", () => {
  const catalog: WarpCatalog = {
    version: "draft-01",
    tracks: [
      {
        name: "video",
        namespace: "cmsf/clear",
        packaging: "cmaf",
        role: "video",
        initRef: "init-video",
      },
      {
        name: "video_locmaf",
        namespace: "cmsf/clear",
        packaging: "locmaf",
        locmafVersion: "0.3",
        role: "video",
        initRef: "init-video",
      },
      {
        name: "loc-only",
        namespace: "msf/clear",
        packaging: "loc",
        role: "video",
      },
    ],
    initDataList: [{ id: "init-video", type: "inline", data: "QUJD" }],
  };

  it("parses the version as a string this player supports", () => {
    expect(typeof catalog.version).toBe("string");
    expect(MSF_SUPPORTED_VERSIONS).toContain(catalog.version);
  });

  it("accepts both spellings of the supported version", () => {
    // draft-ietf-moq-msf-01 shows "1" in all its JSON examples but its
    // Section 5.1.1 prose recommends the draft-XX convention, which mlmpub
    // follows. Both forms are in the wild, so both must parse.
    expect(MSF_SUPPORTED_VERSIONS).toContain("1");
    expect(MSF_SUPPORTED_VERSIONS).toContain("draft-01");

    for (const version of ["1", "draft-01"]) {
      const mgr = new WarpCatalogManager();
      mgr.handleCatalogData({ ...catalog, version });
      expect(mgr.getCatalog()).not.toBeNull();
    }
  });

  it("accepts a draft-01 catalog", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getCatalog()).not.toBeNull();
  });

  it("rejects a catalog with an unsupported version", () => {
    // "1" used to stand in for "unsupported" here; it is supported now, so
    // the rejection case needs a version this player really cannot read.
    for (const version of ["2", "draft-00", "draft-02", ""]) {
      const mgr = new WarpCatalogManager();
      mgr.handleCatalogData({ ...catalog, version });
      expect(mgr.getCatalog()).toBeNull();
    }
  });

  it("resolves a track initRef to the shared init data entry", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);

    const cmaf = catalog.tracks[0];
    const locmaf = catalog.tracks[1];

    // The CMAF and LOCMAF variants share one initDataList entry.
    expect(cmaf.initRef).toBe(locmaf.initRef);
    expect(mgr.getInitData(cmaf)).toBe("QUJD");
    expect(mgr.getInitData(locmaf)).toBe("QUJD");
  });

  it("returns undefined for a track without initRef", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getInitData(catalog.tracks[2])).toBeUndefined();
  });

  it("returns undefined for an unresolved initRef", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getInitData({ name: "x", initRef: "missing" })).toBeUndefined();
  });
});

describe("CTA-608 accessibility descriptor", () => {
  const cc608 = { scheme: CTA608_ACCESSIBILITY_SCHEME, value: "CC1=eng" };

  const captioned: WarpCatalog = {
    version: "draft-01",
    tracks: [
      {
        name: "video",
        packaging: "cmaf",
        role: "video",
        codec: "avc1.640028",
        accessibility: [cc608],
      },
      { name: "audio", packaging: "cmaf", role: "audio" },
    ],
  };

  it("keeps the descriptor through handleCatalogData", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(captioned);
    const track = mgr.getCatalog()?.tracks[0];
    expect(track?.accessibility).toEqual([cc608]);
    expect(trackHasCta608(track)).toBe(true);
  });

  it("keeps the descriptor when the namespace is inherited", () => {
    // The inherit pass mutates tracks in place; it must not disturb the
    // descriptor of a track that omits `namespace`.
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(structuredClone(captioned), "cmsf/clear");
    const track = mgr.getCatalog()?.tracks[0];
    expect(track?.namespace).toBe("cmsf/clear");
    expect(trackHasCta608(track)).toBe(true);
  });

  it("keeps the descriptor on tracks carried in a deltaUpdate", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(
      {
        version: "draft-01",
        tracks: [],
        deltaUpdate: [
          {
            op: "add",
            tracks: [{ name: "video2", role: "video", accessibility: [cc608] }],
          },
        ],
      },
      "cmsf/clear",
    );
    const added = mgr.getCatalog()?.deltaUpdate?.[0].tracks[0];
    expect(added?.namespace).toBe("cmsf/clear");
    expect(trackHasCta608(added)).toBe(true);
  });

  describe("trackHasCta608", () => {
    it("is false for a track with no accessibility field", () => {
      expect(trackHasCta608(captioned.tracks[1])).toBe(false);
    });

    it("is false for null and undefined tracks", () => {
      expect(trackHasCta608(null)).toBe(false);
      expect(trackHasCta608(undefined)).toBe(false);
    });

    it("is false for an empty accessibility array", () => {
      expect(trackHasCta608({ name: "v", accessibility: [] })).toBe(false);
    });

    it("is false for a different accessibility scheme", () => {
      expect(
        trackHasCta608({
          name: "v",
          accessibility: [{ scheme: "urn:scte:dash:cc:cea-708:2015" }],
        }),
      ).toBe(false);
    });

    it("finds the descriptor alongside unrelated ones", () => {
      expect(
        trackHasCta608({
          name: "v",
          accessibility: [{ scheme: "urn:example:other" }, cc608],
        }),
      ).toBe(true);
    });

    it("tolerates malformed entries", () => {
      expect(
        trackHasCta608({
          name: "v",
          accessibility: [null, undefined, {}, cc608] as never,
        }),
      ).toBe(true);
    });

    it("does not match on value alone", () => {
      expect(
        trackHasCta608({
          name: "v",
          accessibility: [{ scheme: "", value: "CC1=eng" }],
        }),
      ).toBe(false);
    });
  });
});
