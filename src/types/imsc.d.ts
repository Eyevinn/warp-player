/**
 * The parts of imscJS (npm `imsc`, https://github.com/sandflow/imscJS) the
 * subtitle path uses. The modules are imported one by one: `main.js` also
 * loads `html.js`, which reads `window` when it loads and so cannot be
 * imported outside a browser.
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

declare module "imsc/src/main/js/doc.js" {
  const imscDoc: {
    fromXML(
      xmlstring: string,
      errorHandler?: ImscErrorHandler,
      metadataHandler?: unknown,
    ): ImscDocument | null;
  };
  export default imscDoc;
}

declare module "imsc/src/main/js/isd.js" {
  const imscIsd: {
    generateISD(
      tt: ImscDocument,
      offset: number,
      errorHandler?: ImscErrorHandler,
    ): ImscIsd;
  };
  export default imscIsd;
}

declare module "imsc/src/main/js/html.js" {
  const imscHtml: {
    render(
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
  };
  export default imscHtml;
}
