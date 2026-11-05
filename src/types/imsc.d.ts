/**
 * The parts of imscJS (npm `imsc`, https://github.com/sandflow/imscJS) the
 * subtitle path uses. The modules are imported one by one: `main.js` also
 * loads `html.js`, which reads `window` when it loads and so cannot be
 * imported outside a browser.
 *
 * imscJS 2 ships declarations generated from its JSDoc, but they are stricter
 * than the code: they make `renderHTML`'s optional arguments required and
 * every error-handler method mandatory. These declare what the code accepts.
 */

/** An imscJS error handler; returning true from a method turns it into a throw. */
interface ImscErrorHandler {
  info?(msg: string): boolean | void;
  warn?(msg: string): boolean | void;
  error?(msg: string): boolean | void;
  fatal?(msg: string): void;
}

/** A parsed TTML document. */
interface ImscDocument {
  /** The times, in seconds, at which the presentation changes. */
  getMediaTimeEvents(): number[];
}

/** One node of an Intermediate Synchronic Document. */
interface ImscIsdElement {
  kind: string;
  text?: string;
  contents?: ImscIsdElement[];
  [key: string]: unknown;
}

/** An Intermediate Synchronic Document: the presentation at one time. */
interface ImscIsd {
  contents: ImscIsdElement[];
  aspectRatio: number | null;
  [key: string]: unknown;
}

/** The XML parser imscJS reads a document through (its `parser.js` contract). */
interface ImscXmlParser {
  write(xml: string): ImscXmlParser;
  close(): ImscXmlParser;
}

declare module "imsc/doc.js" {
  export function fromParser(
    xmlstring: string,
    errorHandler: ImscErrorHandler | null,
    metadataHandler: unknown,
    parser: ImscXmlParser,
  ): ImscDocument | null;
}

declare module "imsc/dom_to_parser.js" {
  /** A parser over the browser's DOMParser. */
  export function createSAXParserFromDOMParser(): ImscXmlParser;
}

declare module "imsc/isd.js" {
  export function generateISD(
    tt: ImscDocument,
    offset: number,
    errorHandler?: ImscErrorHandler,
  ): ImscIsd;
}

declare module "imsc/html.js" {
  export function renderHTML(
    isd: ImscIsd,
    element: HTMLElement,
    imgResolver: ((src: string) => string) | null,
    eheight: number,
    ewidth: number,
    displayForcedOnlyMode?: boolean,
    errorHandler?: ImscErrorHandler | null,
    previousISDState?: unknown,
    enableRollUp?: boolean,
  ): unknown;
}
