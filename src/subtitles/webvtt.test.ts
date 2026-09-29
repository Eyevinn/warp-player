import { parseVttCueText, parseVttSample, parseVttSettings } from "./webvtt";

function box(type: string, payload: Uint8Array | string): Uint8Array {
  const body =
    typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe("parseVttSample", () => {
  it("reads the child boxes of each cue", () => {
    const sample = concat(
      box(
        "vttc",
        concat(
          box("vsid", new Uint8Array([0, 0, 1, 0])),
          box("iden", "c1"),
          box("sttg", "line:2"),
          box("payl", "hello\nworld"),
        ),
      ),
      box("vttc", box("payl", "second")),
    );
    expect(parseVttSample(sample)).toEqual([
      { sourceId: 256, id: "c1", settings: "line:2", text: "hello\nworld" },
      { settings: "", text: "second" },
    ]);
  });

  it("gives no cues for vtte", () => {
    expect(parseVttSample(box("vtte", new Uint8Array(0)))).toEqual([]);
  });
});

describe("parseVttSettings", () => {
  it("defaults to a full-width centred cue", () => {
    expect(parseVttSettings("")).toEqual({ size: 100, align: "center" });
  });

  it("reads line, position, size and align, ignoring what it does not know", () => {
    expect(
      parseVttSettings(
        "line:-2 position:30%,line-left size:40% align:start vertical:rl",
      ),
    ).toEqual({
      line: { value: -2, percent: false },
      position: 30,
      size: 40,
      align: "start",
    });
    expect(parseVttSettings("line:10%").line).toEqual({
      value: 10,
      percent: true,
    });
  });
});

describe("parseVttCueText", () => {
  it("splits lines and styles runs", () => {
    expect(
      parseVttCueText("<b>bold</b> and <i>it<u>al</u></i>\nline 2"),
    ).toEqual([
      [
        { text: "bold", style: { fontWeight: "bold" } },
        { text: " and ", style: {} },
        { text: "it", style: { fontStyle: "italic" } },
        {
          text: "al",
          style: { fontStyle: "italic", textDecoration: "underline" },
        },
      ],
      [{ text: "line 2", style: {} }],
    ]);
  });

  it("maps colour classes, drops voices, timestamps and ruby text", () => {
    expect(
      parseVttCueText(
        "<v Bob><c.yellow.bg_black>hi</c></v> <00:00:01.000>x<ruby>漢<rt>kan</rt></ruby>",
      ),
    ).toEqual([
      [
        { text: "hi", style: { color: "#ffff00", backgroundColor: "#000000" } },
        { text: " ", style: {} },
        { text: "x", style: {} },
        { text: "漢", style: {} },
      ],
    ]);
  });

  it("decodes entities", () => {
    expect(parseVttCueText("a &amp; b &lt;c&gt;&#65;")).toEqual([
      [{ text: "a & b <c>A", style: {} }],
    ]);
  });
});
