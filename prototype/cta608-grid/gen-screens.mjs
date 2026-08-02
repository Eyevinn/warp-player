// Generate AUTHENTIC CaptionScreen fixtures using the real @svta/cml-608 API,
// so the prototype renders the exact structure the production renderer will see.
import { CaptionScreen } from "./scratchpad/package/dist/index.js";

const DEF = {
  foreground: null,
  underline: false,
  italics: false,
  background: "black",
  flash: false,
};

/** Write `text` starting at absolute column `col` on 1-based `row` with the given pen. */
function write(screen, row, col, text, pen = {}) {
  // Use an indent PAC so setPAC moves the cursor to `col` itself. setPAC ends by
  // stamping the pen onto chars[pos] (index.js:420 -> :322), so a PAC with
  // indent:null would leave a stray styled cell wherever the cursor happened to
  // be — usually column 0. That is the pathological case, generated separately.
  const fg = pen.foreground ?? "white";
  screen.setPAC({
    row,
    indent: col,
    color: fg,
    underline: !!pen.underline,
    italics: !!pen.italics,
  });
  screen.setPen({ ...DEF, ...pen, foreground: fg });
  for (const ch of text) screen.insertChar(ch.charCodeAt(0));
}

function centred(len) {
  return Math.max(0, Math.floor((32 - len) / 2));
}

// cml keeps NR_COLS = 100 cells per Row as cursor headroom, but CTA-608 only
// ever addresses 0..31. Assert that and trim, so the fixtures match the grid.
function serialize(screen) {
  const rows = [];
  screen.rows.forEach((r, i) => {
    if (r.isEmpty()) return;
    for (let c = 32; c < r.chars.length; c++) {
      if (!r.chars[c].isEmpty())
        throw new Error(`row ${i}: non-empty cell at col ${c} (beyond 32)`);
    }
    const chars = r.chars.slice(0, 32).map((c) => ({
      u: c.uchar,
      f: c.penState.foreground,
      b: c.penState.background,
      i: c.penState.italics,
      n: c.penState.underline,
    }));
    // trim trailing all-empty cells but keep column indices intact
    rows.push({ row: i, chars });
  });
  return rows;
}

const cases = {};

// 1. The mlmpub case: row 13 white clock, row 14 yellow group tag, both centred.
{
  const s = new CaptionScreen();
  const t = "12:34:56.789";
  const g = "GRP 45296";
  write(s, 13, centred(t.length), t, { foreground: "white" });
  write(s, 14, centred(g.length), g, { foreground: "yellow" });
  cases.mlmpub = {
    label: "mlmpub — two centred rows",
    screens: [serialize(s)],
  };
}

// 2. Grid proof: hard left (col 0), hard right (ends col 31), top row and bottom row.
{
  const s = new CaptionScreen();
  write(s, 1, 0, "TOP-LEFT COL 0", { foreground: "white" });
  const r = "RIGHT COL 31 END";
  write(s, 3, 32 - r.length, r, { foreground: "cyan" });
  write(s, 15, 0, "BOTTOM ROW 15 COL 0", { foreground: "green" });
  const full = "0123456789ABCDEFGHIJKLMNOPQRSTUV"; // exactly 32 chars
  write(s, 8, 0, full, { foreground: "white" });
  cases.grid = {
    label: "grid proof — edges + full 32-char row",
    screens: [serialize(s)],
  };
}

// 3. Styling sampler: all eight foregrounds, italics, underline.
{
  const s = new CaptionScreen();
  const colours = [
    "white",
    "green",
    "blue",
    "cyan",
    "red",
    "yellow",
    "magenta",
  ];
  colours.forEach((c, idx) =>
    write(s, idx + 2, 2, `${c.toUpperCase()} COLOUR`, { foreground: c }),
  );
  write(s, 10, 2, "ITALIC TEXT", { foreground: "white", italics: true });
  write(s, 11, 2, "UNDERLINE TEXT", { foreground: "white", underline: true });
  write(s, 12, 2, "ITALIC + UNDERLINE", {
    foreground: "yellow",
    italics: true,
    underline: true,
  });
  write(s, 14, 2, "TRANSPARENT BG", {
    foreground: "white",
    background: "transparent",
  });
  cases.styles = {
    label: "styling — colours, italics, underline, bg",
    screens: [serialize(s)],
  };
}

// 4. Roll-up: four successive screens, base row 15, three rolling rows.
{
  const lines = [
    "FIRST LINE OF ROLL UP",
    "SECOND LINE APPEARS NOW",
    "THIRD LINE PUSHES UP",
    "FOURTH LINE KEEPS GOING",
    "FIFTH AND FINAL LINE",
  ];
  const screens = [];
  const s = new CaptionScreen();
  s.setRollUpRows(3);
  for (const line of lines) {
    write(s, 15, 0, line, { foreground: "white" });
    screens.push(serialize(s));
    s.rollUp();
  }
  cases.rollup = { label: "roll-up — 3 rows, 5 steps", screens };
}

// 5. Worst case: every row full width, to stress layout and measurement.
{
  const s = new CaptionScreen();
  for (let row = 1; row <= 15; row++) {
    const line =
      `${String(row).padStart(2, "0")}` +
      "".padEnd(0) +
      "-WWWWWWWWWWWWWWWWWWWWWWWWWWWW".slice(0, 30);
    write(s, row, 0, line.slice(0, 32), {
      foreground: row % 2 ? "white" : "yellow",
    });
  }
  cases.stress = {
    label: "stress — all 15 rows, full width",
    screens: [serialize(s)],
  };
}

// 6. Mixed runs on ONE row — the case that separates whole-row stretching from
// per-run exact boxes. Mid-row colour changes are ordinary CTA-608.
{
  const s = new CaptionScreen();
  const parts = [
    ["RED", "red"],
    [" ", "white"],
    ["GREEN", "green"],
    [" ", "white"],
    ["CYAN", "cyan"],
    [" ", "white"],
    ["YELLOW", "yellow"],
  ];
  let col = 0;
  for (const [text, colour] of parts) {
    write(s, 13, col, text, { foreground: colour });
    col += text.length;
  }
  // a second row: style changes mid-word, with italics and underline runs
  const parts2 = [
    ["PLAIN", {}],
    ["ITAL", { italics: true }],
    ["UNDER", { underline: true }],
  ];
  col = 4;
  for (const [text, pen] of parts2) {
    write(s, 15, col, text, { foreground: "white", ...pen });
    col += text.length;
  }
  cases.mixed = {
    label: "mixed runs — colour/style changes mid-row",
    screens: [serialize(s)],
  };
}

// 7. Pathological: an isolated styled cell far from the text. Discovered by
// accident while building these fixtures — a naive first..last span-fill paints
// a black bar all the way from the stray cell to the caption.
{
  const s = new CaptionScreen();
  const g = "GRP 45296";
  write(s, 14, centred(g.length), g, { foreground: "yellow" });
  // one stray yellow space at column 0, nothing else
  s.setPAC({
    row: 14,
    indent: null,
    color: null,
    underline: false,
    italics: false,
  });
  s.setCursor(0);
  s.setPen({ ...DEF, foreground: "yellow" });
  write(s, 12, centred(12), "12:34:56.789", { foreground: "white" });
  cases.pathological = {
    label: "pathological — stray styled cell at col 0",
    screens: [serialize(s)],
  };
}

process.stdout.write(JSON.stringify(cases));
