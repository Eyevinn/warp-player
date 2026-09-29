import {
  TEXT_CC1,
  TEXT_OFF,
  carryTextSelection,
  ccButtonState,
  ccToggleTarget,
  isShowable,
  type TextChoices,
} from "./textSelection";

const STPP = "mlm/cmsf/clear/subs_stpp_en";
const WVTT = "mlm/cmsf/clear/subs_wvtt_sv";

const both: TextChoices = { cc1Available: true, subtitleKeys: [STPP, WVTT] };
const subsOnly: TextChoices = {
  cc1Available: false,
  subtitleKeys: [STPP, WVTT],
};
const ccOnly: TextChoices = { cc1Available: true, subtitleKeys: [] };
const none: TextChoices = { cc1Available: false, subtitleKeys: [] };

describe("isShowable", () => {
  it.each([
    [TEXT_OFF, both, false],
    [TEXT_CC1, both, true],
    [TEXT_CC1, subsOnly, false],
    [STPP, subsOnly, true],
    [STPP, ccOnly, false],
    ["mlm/cmsf/clear/gone", both, false],
  ])("%j with %j is %s", (selection, choices, want) => {
    expect(isShowable(selection, choices)).toBe(want);
  });
});

describe("ccToggleTarget", () => {
  it("brings back the last choice while it can be shown", () => {
    expect(ccToggleTarget(WVTT, both)).toBe(WVTT);
    expect(ccToggleTarget(TEXT_CC1, both)).toBe(TEXT_CC1);
  });

  it("falls back to CC1, then to the first subtitle track", () => {
    expect(ccToggleTarget("mlm/cmsf/clear/gone", both)).toBe(TEXT_CC1);
    expect(ccToggleTarget(TEXT_CC1, subsOnly)).toBe(STPP);
    expect(ccToggleTarget(STPP, ccOnly)).toBe(TEXT_CC1);
  });

  it("has nothing to turn on without choices", () => {
    expect(ccToggleTarget(TEXT_CC1, none)).toBe(TEXT_OFF);
  });
});

describe("ccButtonState", () => {
  it.each([
    [TEXT_OFF, both, { on: false, disabled: false }],
    [TEXT_CC1, both, { on: true, disabled: false }],
    // CC1 chosen on a video track without captions: intent kept, nothing shown.
    [TEXT_CC1, subsOnly, { on: false, disabled: false }],
    [STPP, subsOnly, { on: true, disabled: false }],
    [TEXT_CC1, none, { on: false, disabled: true }],
  ])("%j with %j", (selection, choices, want) => {
    expect(ccButtonState(selection, choices)).toEqual(want);
  });
});

describe("carryTextSelection", () => {
  const drm = [
    { key: "mlm/cmsf/drm-cbcs/subs_stpp_en", name: "subs_stpp_en" },
    { key: "mlm/cmsf/drm-cbcs/subs_wvtt_sv", name: "subs_wvtt_sv" },
  ];

  it("keeps off and CC1 as they are", () => {
    expect(carryTextSelection(TEXT_OFF, drm)).toBe(TEXT_OFF);
    expect(carryTextSelection(TEXT_CC1, [])).toBe(TEXT_CC1);
  });

  it("keeps a track that is still there", () => {
    expect(
      carryTextSelection(STPP, [{ key: STPP, name: "subs_stpp_en" }]),
    ).toBe(STPP);
  });

  it("moves to the track of the same name in the new namespace", () => {
    expect(carryTextSelection(WVTT, drm)).toBe(
      "mlm/cmsf/drm-cbcs/subs_wvtt_sv",
    );
  });

  it("falls back to off when the track is gone", () => {
    expect(carryTextSelection(STPP, [])).toBe(TEXT_OFF);
  });
});
