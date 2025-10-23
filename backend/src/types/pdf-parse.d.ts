declare module 'pdf-parse' {
  import type { Buffer } from 'node:buffer';

  interface PdfParseResult {
    text: string;
    numpages?: number;
  }

  type PdfParse = (data: Buffer, options?: unknown) => Promise<PdfParseResult>;

  const pdfParse: PdfParse;
  export default pdfParse;
}

