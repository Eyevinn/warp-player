import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { CueChannel } from "../overlay";
import type { WarpTrack } from "../warpcatalog";

import { SubtitleController, subtitleTrackKey } from "./controller";
import type { SubtitleObject } from "./receiver";
import type { SubtitleCue } from "./types";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/media-files/subtitles",
);

function init(format: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(dir, `${format}_init.mp4`)));
}

/** The first object of a fixture track. */
function firstObject(format: string): SubtitleObject {
  const buf = new Uint8Array(
    fs.readFileSync(path.join(dir, `${format}_cmaf.objs`)),
  );
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(8);
  return {
    location: { group: 1_000_000n, object: 0n },
    data: buf.subarray(12, 12 + len),
  };
}

const track = (name: string, codec: string): WarpTrack => ({
  name,
  namespace: "mlm/cmsf/clear",
  packaging: "cmaf",
  role: "subtitle",
  codec,
});

const STPP = track("subs_stpp_en", "stpp.ttml.im1t");
const STPC = track("subs_stpc_en", "stpc");
const WVTC = track("subs_wvtc_sv", "wvtc");

function setup() {
  const subscribed = new Map<string, (obj: SubtitleObject) => void>();
  const unsubscribed: bigint[] = [];
  const aliases = new Map<bigint, string>();
  let nextAlias = 1n;
  const cues: [number, number, SubtitleCue][] = [];
  let clears = 0;
  const channel: CueChannel<SubtitleCue> = {
    mode: "cues",
    addCue: (s, e, c) => cues.push([s, e, c]),
    clear: () => {
      clears++;
    },
  };
  const controller = new SubtitleController({
    subscribe: async (t, onObject) => {
      subscribed.set(t.name, onObject);
      const alias = nextAlias++;
      aliases.set(alias, t.name);
      return alias;
    },
    unsubscribe: async (alias) => {
      unsubscribed.push(alias);
      subscribed.delete(aliases.get(alias)!);
    },
    initSegment: (t) => init(t.codec!.slice(0, 4)),
    warn: () => undefined,
  });
  controller.setChannel(channel);
  return { controller, subscribed, unsubscribed, cues, clears: () => clears };
}

describe("SubtitleController", () => {
  it("subscribes to the displayed track and feeds its cues to the channel", async () => {
    const { controller, subscribed, cues } = setup();
    await controller.update(STPC, []);
    expect([...subscribed.keys()]).toEqual(["subs_stpc_en"]);
    expect(controller.isDisplaying()).toBe(true);
    subscribed.get("subs_stpc_en")!(firstObject("stpc"));
    expect(cues).toHaveLength(1);
    expect(cues[0][2].kind).toBe("ttml");
  });

  it("measures other tracks without showing them", async () => {
    const { controller, subscribed, cues } = setup();
    await controller.update(STPC, [STPP, STPC, WVTC]);
    expect([...subscribed.keys()].sort()).toEqual([
      "subs_stpc_en",
      "subs_stpp_en",
      "subs_wvtc_sv",
    ]);
    subscribed.get("subs_stpp_en")!(firstObject("stpp"));
    subscribed.get("subs_wvtc_sv")!(firstObject("wvtc"));
    expect(cues).toHaveLength(0);
    const rows = controller.getRows();
    expect(rows[0].key).toBe(subtitleTrackKey(STPC));
    expect(rows[0].displayed).toBe(true);
    const stpp = rows.find((r) => r.track.name === "subs_stpp_en")!;
    expect(stpp.sampleEntry).toBe("stpp");
    expect(stpp.stats.documentsParsed).toBe(1);
  });

  it("switches the displayed track, clearing the old cues, and keeps shared receivers", async () => {
    const { controller, subscribed, unsubscribed, cues, clears } = setup();
    await controller.update(STPC, [STPC, WVTC]);
    const wvtcCallback = subscribed.get("subs_wvtc_sv");
    const before = clears();
    await controller.update(WVTC, [STPC, WVTC]);
    expect(clears()).toBe(before + 1);
    expect(unsubscribed).toEqual([]);
    expect(subscribed.get("subs_wvtc_sv")).toBe(wvtcCallback);
    subscribed.get("subs_wvtc_sv")!(firstObject("wvtc"));
    subscribed.get("subs_stpc_en")!(firstObject("stpc"));
    expect(cues.map((c) => c[2].kind)).toEqual(["vtt"]);
  });

  it("unsubscribes everything on stop and ignores late objects", async () => {
    const { controller, subscribed, unsubscribed, cues } = setup();
    await controller.update(STPC, [WVTC]);
    const late = subscribed.get("subs_stpc_en")!;
    await controller.stop();
    expect(unsubscribed).toHaveLength(2);
    expect(controller.isDisplaying()).toBe(false);
    expect(controller.getRows()).toEqual([]);
    late(firstObject("stpc"));
    expect(cues).toHaveLength(0);
  });
});
