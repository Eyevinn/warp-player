declare module "codem-isoboxer" {
  export function parseBuffer(buffer: ArrayBuffer): ISOFile | ISOBox;

  export interface ISOFile {
    fetch?(type: string): ISOBox | null;
    fetchAll?(type: string): ISOBox[];
    boxes?: ISOBox[];
    type?: string;
  }

  export interface ISOBox {
    type: string;
    fetch(type: string): ISOBox | null;
    fetchAll(type: string): ISOBox[];
    boxes?: ISOBox[];

    // Common box properties
    /** Absolute byte offset of the box within the parsed buffer. */
    _offset?: number;
    size?: number;
    version?: number;
    flags?: number;

    // mdhd box properties
    timescale?: number;

    // tfdt box properties
    baseMediaDecodeTime?: number;

    // tfhd box properties
    sequence_number?: number;
    track_ID?: number;
    base_data_offset?: number;
    default_sample_duration?: number;
    default_sample_size?: number;
    default_sample_flags?: number;

    // trun box properties
    sample_count?: number;
    data_offset?: number;
    first_sample_flags?: number;
    samples?: {
      sample_duration?: number;
      sample_size?: number;
      sample_flags?: number;
      sample_composition_time_offset?: number;
    }[];
  }
}
