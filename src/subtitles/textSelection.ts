// Which text is shown: nothing, the in-band CTA-608 captions, or one subtitle
// track. One choice at a time, as in any player's Subtitles/CC menu, since
// captions and subtitles share the lower part of the picture.
//
// Extracted from Player so the rules are pure functions with an explicit truth
// table, like ../cc608/gate.ts. The selection is the user's *intent*, kept
// apart from availability: CC1 depends on the video track, so choosing CC1 and
// then a video track without captions shows nothing, and coming back to a
// captioned track shows them again.

/** The selection value for no text. */
export const TEXT_OFF = "";
/** The selection value for the in-band CTA-608 CC1 captions of the video track. */
export const TEXT_CC1 = "cc1";

/** What can be shown now. */
export interface TextChoices {
  /** Whether CC1 can be shown for the current video track. */
  cc1Available: boolean;
  /** The keys of the catalog's subtitle tracks, in catalog order. */
  subtitleKeys: readonly string[];
}

/** True when `selection` names something that can be shown now. */
export function isShowable(selection: string, choices: TextChoices): boolean {
  if (selection === TEXT_CC1) {
    return choices.cc1Available;
  }
  return selection !== TEXT_OFF && choices.subtitleKeys.includes(selection);
}

/**
 * What the CC button turns on: the last thing shown if it still can be, else
 * CC1, else the first subtitle track. TEXT_OFF when there is nothing.
 */
export function ccToggleTarget(last: string, choices: TextChoices): string {
  if (isShowable(last, choices)) {
    return last;
  }
  if (choices.cc1Available) {
    return TEXT_CC1;
  }
  return choices.subtitleKeys[0] ?? TEXT_OFF;
}

export interface CcButtonState {
  /** The selection is showing something. */
  on: boolean;
  /** Nothing can be shown, so the button has nothing to toggle. */
  disabled: boolean;
}

/** The CC button follows the selector: on when it shows something. */
export function ccButtonState(
  selection: string,
  choices: TextChoices,
): CcButtonState {
  return {
    on: isShowable(selection, choices),
    disabled: !choices.cc1Available && choices.subtitleKeys.length === 0,
  };
}

/**
 * Carry a subtitle selection over to a new catalog. The key is kept if the
 * track is still there, else it moves to a track of the same name in another
 * namespace (cmsf/clear → cmsf/drm-cbcs carries the same subtitle tracks),
 * else the selection falls back to off. TEXT_OFF and TEXT_CC1 carry over as
 * they are. `tracks` are the new catalog's subtitle tracks.
 */
export function carryTextSelection(
  selection: string,
  tracks: readonly { key: string; name: string }[],
): string {
  if (selection === TEXT_OFF || selection === TEXT_CC1) {
    return selection;
  }
  if (tracks.some((t) => t.key === selection)) {
    return selection;
  }
  return tracks.find((t) => selection.endsWith(`/${t.name}`))?.key ?? TEXT_OFF;
}
