/**
 * TTML documents to timed presentation states, through imscJS — the same
 * library dash.js uses, so layout and styling follow IMSC, and the parse
 * work per document is the work dash.js does.
 *
 * A document becomes the intervals between its media time events, each with
 * the Intermediate Synchronic Document (ISD) shown over it. The times are the
 * document's own and are not clipped: the last interval stays open, since a
 * cue with no `end` has not ended yet. Clipping to a sample is the receiver's
 * job, which is what lets a paint-model receiver keep a document's
 * presentation across no-change samples without parsing again.
 */
import imscDoc from "imsc/src/main/js/doc.js";
import imscIsd from "imsc/src/main/js/isd.js";

/** A presentation state and the interval it is shown over, in media ms. */
export interface TtmlInterval {
  begin: number;
  /** Infinity for the open interval after the document's last change. */
  end: number;
  isd: ImscIsd;
}

/** Parse a TTML document. Throws if imscJS cannot make a document of it. */
export function parseTtml(text: string): TtmlInterval[] {
  const errors: string[] = [];
  const handler: ImscErrorHandler = {
    error: (msg) => {
      errors.push(msg);
    },
    fatal: (msg) => {
      errors.push(msg);
    },
  };
  const doc = imscDoc.fromXML(text, handler);
  if (!doc) {
    throw new Error(
      `not a TTML document${errors.length ? `: ${errors[0]}` : ""}`,
    );
  }
  const events = doc.getMediaTimeEvents();
  const intervals: TtmlInterval[] = [];
  for (let i = 0; i < events.length; i++) {
    const isd = imscIsd.generateISD(doc, events[i], handler);
    if (!isdHasText(isd)) {
      continue;
    }
    intervals.push({
      begin: events[i] * 1000,
      end: i + 1 < events.length ? events[i + 1] * 1000 : Infinity,
      isd,
    });
  }
  return intervals;
}

/** True when the ISD shows any text. An ISD with regions but no text shows nothing. */
export function isdHasText(isd: ImscIsd | ImscIsdElement): boolean {
  const node = isd as ImscIsdElement;
  if (typeof node.text === "string" && node.text.trim().length > 0) {
    return true;
  }
  return (node.contents ?? []).some(isdHasText);
}

/**
 * Splice a body-only `ttmb` payload into the full document it depends on:
 * the `<body>` element of `doc` (the group's first document) is replaced by
 * `body`, keeping the root element with its namespace declarations and the
 * `<head>`. Null if `doc` has no body to replace.
 */
export function spliceBody(doc: string, body: string): string | null {
  const open = /<([\w.-]+:)?body[\s/>]/.exec(doc);
  if (!open) {
    return null;
  }
  const start = open.index;
  const closeTag = `</${open[1] ?? ""}body>`;
  const close = doc.indexOf(closeTag, start);
  let end: number;
  if (close >= 0) {
    end = close + closeTag.length;
  } else {
    const tagEnd = doc.indexOf(">", start);
    if (tagEnd < 0 || doc[tagEnd - 1] !== "/") {
      return null;
    }
    end = tagEnd + 1; // <body/>
  }
  return doc.slice(0, start) + body.trim() + doc.slice(end);
}
