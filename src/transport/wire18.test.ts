import { ByteReader, ByteWriter, namespaceFields } from "./wire18";

const decode = (fields: Uint8Array[]): string[] =>
  fields.map((f) => new TextDecoder().decode(f));

describe("namespaceFields", () => {
  it("splits a slash-joined namespace into one field per element", () => {
    expect(decode(namespaceFields("cmsf/clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("moq-test/interop"))).toEqual([
      "moq-test",
      "interop",
    ]);
    expect(decode(namespaceFields("a/b/c"))).toEqual(["a", "b", "c"]);
  });

  it("keeps a single-element namespace as one field", () => {
    expect(decode(namespaceFields("single"))).toEqual(["single"]);
  });

  it("drops empty fields, which cannot be encoded", () => {
    // Section 2.4.1: a Track Namespace Field MUST contain at least one byte.
    expect(decode(namespaceFields("/cmsf/clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("cmsf//clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("cmsf/clear/"))).toEqual(["cmsf", "clear"]);
    expect(namespaceFields("")).toEqual([]);
    expect(namespaceFields("/")).toEqual([]);
  });

  it("round-trips through the wire encoding", () => {
    // A namespace written as a tuple must read back as the same fields, so a
    // relay matching the prefix ("cmsf") sees a field it can compare against.
    const w = new ByteWriter(64);
    w.namespace(namespaceFields("cmsf/clear"));
    const r = new ByteReader(w.take());
    expect(decode(r.namespace())).toEqual(["cmsf", "clear"]);
  });
});
