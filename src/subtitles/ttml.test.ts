import { isdHasText, parseTtml, spliceBody } from "./ttml";

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="media" xml:lang="en">
  <head>
    <styling><style xml:id="s1" tts:color="yellow" tts:backgroundColor="black"/></styling>
    <layout><region xml:id="r0" tts:origin="15% 80%" tts:extent="70% 20%"/></layout>
  </head>
`;

function doc(body: string): string {
  return `${HEAD}${body}</tt>`;
}

function texts(isd: ImscIsd): string[] {
  const out: string[] = [];
  const walk = (n: ImscIsdElement): void => {
    if (typeof n.text === "string") {
      out.push(n.text);
    }
    (n.contents ?? []).forEach(walk);
  };
  isd.contents.forEach(walk);
  return out;
}

describe("parseTtml", () => {
  it("gives a closed cue its interval in media milliseconds", () => {
    const intervals = parseTtml(
      doc(`<body><div region="r0">
<p begin="277:46:40.000" end="277:46:40.900"><span style="s1">hello</span></p>
</div></body>`),
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0].begin).toBe(1_000_000_000);
    expect(intervals[0].end).toBeCloseTo(1_000_000_900, 3);
    expect(texts(intervals[0].isd)).toEqual(["hello"]);
  });

  it("keeps a cue without an end open", () => {
    const intervals = parseTtml(
      doc(
        `<body><div region="r0"><p begin="00:00:10.000"><span>still up</span></p></div></body>`,
      ),
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0].begin).toBe(10_000);
    expect(intervals[0].end).toBe(Infinity);
  });

  it("splits a document at every change, and drops intervals that show nothing", () => {
    const intervals = parseTtml(
      doc(`<body><div region="r0">
<p begin="1s" end="3s"><span>one</span></p>
<p begin="2s" end="4s"><span>two</span></p>
</div></body>`),
    );
    expect(intervals.map((i) => [i.begin, i.end])).toEqual([
      [1000, 2000],
      [2000, 3000],
      [3000, 4000],
    ]);
    expect(texts(intervals[1].isd)).toEqual(["one", "two"]);
  });

  it("returns nothing for a document with an empty body", () => {
    expect(parseTtml(doc(`<body><div region="r0"/></body>`))).toEqual([]);
  });

  it("throws on something that is not TTML", () => {
    expect(() => parseTtml("<html><body/></html>")).toThrow();
  });
});

describe("isdHasText", () => {
  it("ignores regions and whitespace without text", () => {
    expect(
      isdHasText({
        contents: [{ kind: "region", contents: [] }],
        aspectRatio: null,
      }),
    ).toBe(false);
    expect(
      isdHasText({
        contents: [{ kind: "span", text: "  " }],
        aspectRatio: null,
      }),
    ).toBe(false);
    expect(
      isdHasText({
        contents: [{ kind: "region", contents: [{ kind: "span", text: "x" }] }],
        aspectRatio: null,
      }),
    ).toBe(true);
  });
});

describe("spliceBody", () => {
  const head = doc(
    `  <body style="s0"><div region="r0"><p begin="1s">old</p></div></body>\n`,
  );

  it("replaces the body and keeps the root and head", () => {
    const spliced = spliceBody(
      head,
      `  <body><div region="r0"><p begin="2s">new</p></div></body>\n`,
    );
    expect(spliced).not.toBeNull();
    expect(spliced).toContain("<styling>");
    expect(spliced).toContain(">new<");
    expect(spliced).not.toContain(">old<");
    expect(spliced!.trimEnd().endsWith("</tt>")).toBe(true);
    expect(texts(parseTtml(spliced!)[0].isd)).toEqual(["new"]);
  });

  it("replaces a self-closing body", () => {
    const spliced = spliceBody(
      doc(`<body/>`),
      `<body><div region="r0"><p>x</p></div></body>`,
    );
    expect(spliced).toContain("<p>x</p>");
  });

  it("handles a prefixed TTML namespace", () => {
    const prefixed = `<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:head/><tt:body><tt:div/></tt:body></tt:tt>`;
    expect(
      spliceBody(
        prefixed,
        "<tt:body><tt:div><tt:p>y</tt:p></tt:div></tt:body>",
      ),
    ).toBe(
      `<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:head/><tt:body><tt:div><tt:p>y</tt:p></tt:div></tt:body></tt:tt>`,
    );
  });

  it("gives null when there is no body to replace", () => {
    expect(
      spliceBody(`<tt xmlns="http://www.w3.org/ns/ttml"></tt>`, "<body/>"),
    ).toBeNull();
  });
});
