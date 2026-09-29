// sax, the XML parser inside imscJS, defines an optional SAXStream on top of
// Node's `stream` module as soon as it loads. imscJS only uses sax's plain
// parser, so the browser build resolves `stream` to this: a base class that is
// never instantiated. See the resolve.fallback in webpack.config.mjs.
export class Stream {}
