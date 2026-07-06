import {
  MSF_SUPPORTED_VERSION,
  WarpCatalog,
  WarpCatalogManager,
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

  it("parses the draft-01 string version", () => {
    expect(typeof catalog.version).toBe("string");
    expect(catalog.version).toBe(MSF_SUPPORTED_VERSION);
  });

  it("accepts a draft-01 catalog", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getCatalog()).not.toBeNull();
  });

  it("rejects a catalog with an unsupported version", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData({ ...catalog, version: "1" });
    expect(mgr.getCatalog()).toBeNull();
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
