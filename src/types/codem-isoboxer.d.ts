declare module 'codem-isoboxer' {
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
    
    // mdhd box properties
    timescale?: number;
    
    // tfdt box properties
    baseMediaDecodeTime?: number;
    
    // tfhd box properties
    sequence_number?: number;
    default_sample_duration?: number;
    
    // trun box properties
    sample_count?: number;
    samples?: {
      sample_duration?: number;
      sample_size?: number;
      sample_flags?: number;
      sample_composition_time_offset?: number;
    }[];
  }
}
