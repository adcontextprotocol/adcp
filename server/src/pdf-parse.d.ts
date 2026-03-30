declare module 'pdf-parse' {
  interface PDFParseImage {
    data?: Uint8Array | Buffer;
    name?: string;
    kind: number | string;
    width?: number;
    height?: number;
  }

  interface PDFParseImagePage {
    pageNumber: number;
    images: PDFParseImage[];
  }

  export class PDFParse {
    constructor(options: { data: Uint8Array });
    getText(): Promise<{ text?: string }>;
    getImage(options?: { imageBuffer?: boolean; imageThreshold?: number }): Promise<{
      pages: PDFParseImagePage[];
    }>;
    destroy(): Promise<void>;
  }
}
