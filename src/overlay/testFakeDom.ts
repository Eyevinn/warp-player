// A minimal element/document stand-in, enough to exercise the overlay's DOM
// plumbing (attach / tick / reset / detach) under the "node" Jest
// environment. Deliberately not jsdom: the overlay's geometry is CSS pixels
// that jsdom does not lay out either, so a real DOM would buy nothing but a
// dependency. Anything needing genuine layout — glyph advance measurement —
// is verified live in the verification ticket.

/** A stubbed element. `children` is the assertion surface. */
export class FakeElement {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  /** No layout engine here, so the glyph probe measures 0 and scale is 1. */
  readonly offsetWidth = 0;
  private box = { left: 0, top: 0, width: 0, height: 0 };

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children.length = 0;
    for (const node of nodes) {
      // A fragment splices its own children in, as the real API does.
      if (node.tagName === "#fragment") {
        for (const grandchild of node.children) {
          this.appendChild(grandchild);
        }
        node.children.length = 0;
        continue;
      }
      this.appendChild(node);
    }
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (siblings) {
      const idx = siblings.indexOf(this);
      if (idx >= 0) {
        siblings.splice(idx, 1);
      }
    }
    this.parent = null;
  }

  setAttribute(): void {
    // no-op
  }

  setBox(left: number, top: number, width: number, height: number): void {
    this.box = { left, top, width, height };
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    return { ...this.box };
  }

  /** Every descendant, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export class FakeDocument {
  readonly body = new FakeElement("body", this);

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement("#fragment", this);
  }
}

/** A `<canvas>`-shaped surface with an intrinsic size and a laid-out box. */
export class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;

  constructor(doc: FakeDocument) {
    super("canvas", doc);
  }
}

/** Cast helper: these stubs stand in for real DOM nodes in the overlay API. */
export function asDom<T>(value: unknown): T {
  return value as T;
}
