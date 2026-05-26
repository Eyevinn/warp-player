/**
 * Shared SampleEncryptionBox helpers for the LOCMAF decoders.
 *
 * `@svta/cml-iso-bmff` has native readers for `senc` but no
 * writer, so both LOCMAF v0.1 and v0.2 reconstruct the box in
 * memory and serialize it themselves. The serializer lives here so
 * the two versioned decoders can use it without one depending on
 * the other.
 */
import { IsoBoxWriteView, type SampleEncryptionBox } from "@svta/cml-iso-bmff";

/** `flags & 0x02 = 1` means each sample carries a subsample map. */
export const SENC_USE_SUBSAMPLE_ENCRYPTION = 0x000002;

export type SampleEncryptionEntry = {
  initializationVector?: Uint8Array;
  subsampleEncryption?: Array<{
    bytesOfClearData: number;
    bytesOfProtectedData: number;
  }>;
};

export type ExtendedSampleEncryptionBox = SampleEncryptionBox & {
  type: "senc";
  samples: SampleEncryptionEntry[];
};

/** Serialize an `ExtendedSampleEncryptionBox` into a write view. */
export function writeSenc(box: ExtendedSampleEncryptionBox): IsoBoxWriteView {
  let size = 8 + 4 + 4;
  for (const sample of box.samples) {
    size += sample.initializationVector?.byteLength ?? 0;
    if (box.flags & SENC_USE_SUBSAMPLE_ENCRYPTION) {
      size += 2;
      size += (sample.subsampleEncryption?.length ?? 0) * 6;
    }
  }

  const writer = new IsoBoxWriteView("senc", size);
  writer.writeFullBox(box.version, box.flags);
  writer.writeUint(box.sampleCount, 4);

  for (const sample of box.samples) {
    if (sample.initializationVector) {
      writer.writeBytes(sample.initializationVector);
    }
    if (box.flags & SENC_USE_SUBSAMPLE_ENCRYPTION) {
      const subsamples = sample.subsampleEncryption ?? [];
      writer.writeUint(subsamples.length, 2);
      for (const subsample of subsamples) {
        writer.writeUint(subsample.bytesOfClearData, 2);
        writer.writeUint(subsample.bytesOfProtectedData, 4);
      }
    }
  }

  return writer;
}
