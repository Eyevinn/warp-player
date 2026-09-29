/**
 * The subtitle subscriptions of a playback session.
 *
 * One track is displayed; any number of others can be received alongside it
 * for measurement only, which is how the player shows `stpp`, `stpc`, `wvtt`
 * and `wvtc` side by side, as CMAF and as LOCMAF. Every received track is
 * parsed and counted the same way; only the displayed one feeds the overlay.
 */
import type { CueChannel } from "../overlay";
import type { WarpTrack } from "../warpcatalog";

import {
  SubtitleTrackReceiver,
  type SubtitleObject,
  type SubtitleStats,
} from "./receiver";
import type { SubtitleCue } from "./types";

export interface SubtitleControllerDeps {
  /** Subscribe to a track; resolves to the alias to unsubscribe with. */
  subscribe(
    track: WarpTrack,
    onObject: (obj: SubtitleObject) => void,
  ): Promise<bigint>;
  unsubscribe(alias: bigint): Promise<void>;
  /** The raw CMAF init segment of a track, from the catalog. */
  initSegment(track: WarpTrack): Uint8Array | null;
  warn(msg: string): void;
}

/** One row of the comparison table. */
export interface SubtitleStatsRow {
  key: string;
  track: WarpTrack;
  sampleEntry: string;
  displayed: boolean;
  stats: SubtitleStats;
}

interface Entry {
  track: WarpTrack;
  receiver: SubtitleTrackReceiver;
  /** Resolves to the alias once subscribed; null if the subscription failed. */
  alias: Promise<bigint | null>;
}

export function subtitleTrackKey(track: WarpTrack): string {
  return `${track.namespace ?? ""}/${track.name}`;
}

export class SubtitleController {
  private readonly entries = new Map<string, Entry>();
  private displayedKey: string | null = null;
  private channel: CueChannel<SubtitleCue> | null = null;
  /** Serialises reconciliations so overlapping UI changes cannot race. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SubtitleControllerDeps) {}

  /** Where the displayed track's cues go. */
  setChannel(channel: CueChannel<SubtitleCue> | null): void {
    this.channel = channel;
    this.refreshSinks();
  }

  /** True while a track is displayed. */
  isDisplaying(): boolean {
    return this.displayedKey !== null && this.entries.has(this.displayedKey);
  }

  /**
   * Make the subscriptions match: `displayed` shown (or nothing), and every
   * track in `measured` received for its counts. Tracks no longer wanted are
   * unsubscribed; a track that stays keeps its receiver and its counts.
   */
  update(
    displayed: WarpTrack | null,
    measured: readonly WarpTrack[],
  ): Promise<void> {
    const run = this.queue.then(() => this.reconcile(displayed, measured));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Unsubscribe everything. */
  stop(): Promise<void> {
    return this.update(null, []);
  }

  /** Stats for every received track: the displayed one first, then catalog order. */
  getRows(): SubtitleStatsRow[] {
    const rows: SubtitleStatsRow[] = [];
    for (const [key, entry] of this.entries) {
      rows.push({
        key,
        track: entry.track,
        sampleEntry: entry.receiver.sampleEntry,
        displayed: key === this.displayedKey,
        stats: entry.receiver.getStats(),
      });
    }
    return rows.sort((a, b) => Number(b.displayed) - Number(a.displayed));
  }

  private async reconcile(
    displayed: WarpTrack | null,
    measured: readonly WarpTrack[],
  ): Promise<void> {
    const wanted = new Map<string, WarpTrack>();
    for (const track of measured) {
      wanted.set(subtitleTrackKey(track), track);
    }
    const newDisplayed = displayed ? subtitleTrackKey(displayed) : null;
    if (displayed && newDisplayed) {
      wanted.set(newDisplayed, displayed);
    }

    if (newDisplayed !== this.displayedKey) {
      // The old cues belong to another track: clear them before the new
      // track's first cue can arrive.
      this.channel?.clear();
      this.displayedKey = newDisplayed;
    }

    const removals: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (!wanted.has(key)) {
        this.entries.delete(key);
        entry.receiver.setSink(null);
        removals.push(this.unsubscribe(entry));
      }
    }
    for (const [key, track] of wanted) {
      if (!this.entries.has(key)) {
        this.add(key, track);
      }
    }
    this.refreshSinks();
    await Promise.all([
      ...removals,
      ...Array.from(this.entries.values(), (e) => e.alias),
    ]);
  }

  private add(key: string, track: WarpTrack): void {
    const init = this.deps.initSegment(track);
    if (!init) {
      this.deps.warn(`subtitles: no init data for ${key}`);
      return;
    }
    let receiver: SubtitleTrackReceiver;
    try {
      receiver = new SubtitleTrackReceiver({
        initSegment: init,
        packaging: track.packaging === "locmaf" ? "locmaf" : "cmaf",
        locmafVersion: track.locmafVersion,
        onWarning: (msg) => this.deps.warn(`${msg} (${key})`),
      });
    } catch (err) {
      this.deps.warn(`subtitles: cannot receive ${key}: ${String(err)}`);
      return;
    }
    const entry: Entry = {
      track,
      receiver,
      alias: this.deps
        .subscribe(track, (obj) => {
          // Objects in flight after an unsubscribe must not reach a new receiver.
          if (this.entries.get(key) === entry) {
            receiver.receiveObject(obj);
          }
        })
        .catch((err) => {
          this.deps.warn(
            `subtitles: subscribing to ${key} failed: ${String(err)}`,
          );
          return null;
        }),
    };
    this.entries.set(key, entry);
  }

  private async unsubscribe(entry: Entry): Promise<void> {
    const alias = await entry.alias;
    if (alias === null) {
      return;
    }
    try {
      await this.deps.unsubscribe(alias);
    } catch (err) {
      this.deps.warn(
        `subtitles: unsubscribing from ${subtitleTrackKey(entry.track)} failed: ${String(err)}`,
      );
    }
  }

  private refreshSinks(): void {
    for (const [key, entry] of this.entries) {
      const channel = this.channel;
      entry.receiver.setSink(
        key === this.displayedKey && channel
          ? (start, end, cue) => channel.addCue(start, end, cue)
          : null,
      );
    }
  }
}
