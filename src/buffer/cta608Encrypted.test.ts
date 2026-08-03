/**
 * CTA-608 extraction from **encrypted** CMAF fragments (cbcs subsample
 * encryption) — Eyevinn/warp-player#163.
 *
 * The question this file answers: can the player read captions out of the
 * DRM/ECCP namespaces, where it never holds a key? In the browser the answer
 * has to be yes or no *before* decryption, because EME decrypts inside the
 * media stack — JavaScript only ever appends ciphertext to the SourceBuffer.
 *
 * It works, and not by luck:
 *
 *   * mlmpub injects the caption SEI **before** encryption, so the data is
 *     present in the ciphertext stream.
 *   * cbcs subsample encryption leaves a clear leader covering the non-VCL NAL
 *     units and the start of the VCL NAL unit; **only part of the VCL NAL unit
 *     is encrypted**. The caption SEI is a non-VCL NAL unit, so it is wholly
 *     in the clear. Measured on these fixtures: AVC 100 clear / 16775
 *     protected with the 87-byte SEI at offset 0; HEVC 119 / 17710 with the
 *     88-byte prefix SEI at offset 0.
 *   * NAL **length prefixes are never encrypted**, and the cml walk is
 *     prefix-driven rather than a start-code scan: it reads a clear 32-bit
 *     length, steps over the payload, and reads the next clear length. It
 *     only looks *inside* a NAL unit that its header (also clear) identifies
 *     as SEI. So encrypted bytes are stepped over, never interpreted — which
 *     is why no subsample-range parsing is needed to stay safe.
 *
 * Fixtures are real `mlmpub -cc608` output from `cmsf/drm-cbcs`; see the
 * README beside them. `cmsf/eccp-cbcs` is deliberately not fixtured: it
 * differs only in key delivery, not in the bitstream.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import * as ISOBoxer from "codem-isoboxer";

import { snapshotRowText } from "../cc608/snapshot";
import { Cc608Source } from "../cc608/source";
import type { Cc608Sink, Cc608Snapshot } from "../cc608/types";
import { LogLevel, type ILogger } from "../logger";

import { extractCta608FromFragment } from "./cta608Fragment";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../../test/media-files/cta608");

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  getCategory: () => "cta608-encrypted-test",
  setLevel: (_level: LogLevel) => undefined,
};

/** Both fixtures are 30 fragments at 25 fps, timescale 12800. */
const TIMESCALE = 12800;

const FIXTURES = [
  {
    name: "AVC",
    file: "enc_cbcs_h264.m4s",
    clock: "04:51:12.000",
    group: "GRP 1785732672",
    /** First sample: 1 subsample, 100 bytes clear, SEI is NAL #0 (87 B). */
    clearBytes: 100,
    seiNalSize: 87,
  },
  {
    name: "HEVC",
    file: "enc_cbcs_h265.m4s",
    clock: "04:51:16.000",
    group: "GRP 1785732676",
    /** First sample: 1 subsample, 119 bytes clear, prefix SEI is NAL #0 (88 B). */
    clearBytes: 119,
    seiNalSize: 88,
  },
] as const;

function readFixture(file: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(fixtureDir, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

class RecordingSink implements Cc608Sink {
  public readonly pushes: { timeMs: number; screen: Cc608Snapshot | null }[] =
    [];
  public push(timeMs: number, screen: Cc608Snapshot | null): void {
    this.pushes.push({ timeMs, screen });
  }
}

/** Non-empty row text of a snapshot, trailing padding trimmed. */
function rows(screen: Cc608Snapshot): string[] {
  return screen.rows
    .map((r) => snapshotRowText(r).replace(/\s+$/, "").trim())
    .filter((s) => s.length > 0);
}

describe.each(FIXTURES)(
  "CTA-608 from cbcs-encrypted fragments ($name)",
  ({ file, clock, group, clearBytes, seiNalSize }) => {
    it("decodes the caption without a key", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);
      const fed = extractCta608FromFragment(
        readFixture(file),
        TIMESCALE,
        source,
        logger,
      );

      expect(fed).toBe(30);

      const screens = sink.pushes
        .map((p) => p.screen)
        .filter((s): s is Cc608Snapshot => s !== null)
        .map(rows)
        .filter((r) => r.length > 0);

      expect(screens.length).toBeGreaterThan(0);
      // mlmpub's two-line caption: UTC clock on row 13, group tag on row 14.
      expect(screens[screens.length - 1]).toEqual([clock, group]);
    });

    it("advances cue times on the media timeline", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);
      extractCta608FromFragment(readFixture(file), TIMESCALE, source, logger);

      const times = sink.pushes.map((p) => p.timeMs);
      expect(times.length).toBeGreaterThan(0);
      // Monotonic, and inside the 30-sample (1.2 s at 25 fps) window.
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
      expect(times[times.length - 1] - times[0]).toBeLessThan(2000);
    });

    it("really is encrypted: every fragment carries senc", () => {
      // Guards the fixture itself. If a future recapture accidentally lands
      // plaintext (mlmsub decrypts ECCP on the way out, for instance), this
      // whole file would still pass while proving nothing.
      const parsed: any = ISOBoxer.parseBuffer(readFixture(file));
      const moofs = parsed.boxes.filter((b: any) => b.type === "moof");
      expect(moofs.length).toBe(30);
      for (const moof of moofs) {
        const traf = moof.boxes.find((b: any) => b.type === "traf");
        expect(traf).toBeDefined();
        const senc = traf.boxes.find((b: any) => b.type === "senc");
        expect(senc).toBeDefined();
      }
    });

    it("keeps the caption SEI inside the clear subsample leader", () => {
      // The structural reason the walk is safe, asserted rather than assumed:
      // NAL #0 is the SEI and ends before the encrypted range begins.
      const buf = readFixture(file);
      const dv = new DataView(buf);
      const parsed: any = ISOBoxer.parseBuffer(buf);
      const moof = parsed.boxes.find((b: any) => b.type === "moof");
      const mdat = parsed.boxes.find((b: any) => b.type === "mdat");
      expect(moof).toBeDefined();
      expect(mdat).toBeDefined();

      // First sample starts at the mdat body (single-sample fragments).
      const sampleStart = mdat._offset + 8;
      const firstNalSize = dv.getUint32(sampleStart);
      expect(firstNalSize).toBe(seiNalSize);

      // The 4-byte prefix plus the SEI NAL must fit inside the clear leader.
      expect(4 + firstNalSize).toBeLessThanOrEqual(clearBytes);

      // The next NAL unit is the VCL one, and it runs past the clear leader.
      const secondNalStart = sampleStart + 4 + firstNalSize;
      const secondNalSize = dv.getUint32(secondNalStart);
      const secondNalEnd = secondNalStart + 4 + secondNalSize;
      expect(secondNalEnd).toBeGreaterThan(sampleStart + clearBytes);
    });
  },
);
