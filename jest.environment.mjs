import { createRequire } from "node:module";

import { TestEnvironment } from "jest-environment-node";

const require = createRequire(import.meta.url);

/**
 * Node, plus the browser's DOMParser: imscJS reads TTML through it. The tests
 * borrow jsdom's, loaded here rather than inside the test sandbox because
 * jsdom requires ES modules, which only Node's own require can do. It loads on
 * first use: jsdom takes about half a second to load, and most test files
 * parse no XML.
 */
export default class extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    let window;
    for (const name of ["DOMParser", "Node"]) {
      Object.defineProperty(this.global, name, {
        configurable: true,
        get() {
          window ??= new (require("jsdom").JSDOM)().window;
          return window[name];
        },
      });
    }
  }
}
