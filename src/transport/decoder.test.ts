import { Decoder } from "./control";
import { Reader } from "./stream";

describe("Decoder", () => {
  function hexStringToBytes(hexString: string): Uint8Array {
    const bytes = hexString.split(" ").map((hex) => parseInt(hex, 16));
    return new Uint8Array(bytes);
  }

  describe("RequestsBlocked message", () => {
    it("should parse a REQUESTS_BLOCKED message with maximum request ID of 0", async () => {
      // REQUESTS_BLOCKED message format:
      // Type (varint): 0x1a = REQUESTS_BLOCKED
      // Length (16-bit MSB): 0x00 0x01 (1 byte of data follows)
      // Maximum Request ID (varint): 0x00 (value 0, size=0)
      const bytes = hexStringToBytes("1a 00 01 00");

      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      const reader = new Reader(new Uint8Array(), mockStream);
      const decoder = new Decoder(reader);

      const msg = await decoder.message();

      expect(msg.kind).toBe("requests_blocked");
      if (msg.kind === "requests_blocked") {
        expect(msg.maximumRequestId).toBe(0n);
      }
    });

    it("should parse a REQUESTS_BLOCKED message with maximum request ID of 64", async () => {
      // REQUESTS_BLOCKED with Maximum Request ID of 64
      // Type (varint): 0x1a
      // Length (16-bit MSB): 0x00 0x02 (2 bytes of data follow)
      // Maximum Request ID: 64 = 0x40 0x40 (QUIC varint: size=1, value high bits, value low byte)
      const bytes = hexStringToBytes("1a 00 02 40 40");

      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      const reader = new Reader(new Uint8Array(), mockStream);
      const decoder = new Decoder(reader);

      const msg = await decoder.message();

      expect(msg.kind).toBe("requests_blocked");
      if (msg.kind === "requests_blocked") {
        expect(msg.maximumRequestId).toBe(64n);
      }
    });

    it("should parse a REQUESTS_BLOCKED message with large maximum request ID (256)", async () => {
      // REQUESTS_BLOCKED with Maximum Request ID of 256
      // Type (varint): 0x1a
      // Length (16-bit MSB): 0x00 0x02 (2 bytes of data follow)
      // Maximum Request ID: 256 = 0x41 0x00 (QUIC varint with size=1)
      const bytes = hexStringToBytes("1a 00 02 41 00");

      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      const reader = new Reader(new Uint8Array(), mockStream);
      const decoder = new Decoder(reader);

      const msg = await decoder.message();

      expect(msg.kind).toBe("requests_blocked");
      if (msg.kind === "requests_blocked") {
        expect(msg.maximumRequestId).toBe(256n);
      }
    });

    it("should throw error for unknown message type", async () => {
      // Unknown message type: 255 (0xff not a valid message type)
      // Type (QUIC varint): 255 = 0x40 0xff (size=1, value needs 2 bytes)
      // Length (16-bit MSB): 0x00 0x00 (0 bytes of data)
      const bytes = hexStringToBytes("40 ff 00 00");

      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      const reader = new Reader(new Uint8Array(), mockStream);
      const decoder = new Decoder(reader);

      await expect(decoder.message()).rejects.toThrow(/Unknown message type/);
    });
  });
});
