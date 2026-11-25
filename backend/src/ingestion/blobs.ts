import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import type { Config } from '../config/env.js';
import { ApiError } from '../errors.js';

const types: Record<string,string> = {
  '.txt':'text/plain', '.md':'text/markdown', '.markdown':'text/markdown',
  '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export function blobDirectory(config: Config) {
  return config.env.BLOB_DIRECTORY ?? join(dirname(config.env.DATABASE_PATH),'blobs');
}
function unsupported(reason: string): never {
  throw new ApiError(415,'unsupported_media',reason);
}
export function mediaType(name: string, declared: string) {
  const mime = types[extname(name).toLowerCase()];
  if (!mime || !(declared === mime || declared === 'application/octet-stream' ||
    mime === 'text/markdown' && ['text/plain','text/x-markdown'].includes(declared)))
    unsupported('Choose a TXT, Markdown, PDF or DOCX file with a matching media type.');
  return mime;
}

// Inspect the central directory and local entries without extracting paths to disk.
// Bound both declared and actual expanded bytes, including non-document entries.
function validateDocx(bytes: Buffer) {
  const invalid = () => unsupported('Expected a bounded Word DOCX container.');
  const eocd = bytes.lastIndexOf(Buffer.from([0x50,0x4b,5,6]));
  if (eocd < 0 || eocd+22 > bytes.length || bytes.readUInt16LE(eocd+20)+eocd+22 !== bytes.length ||
      bytes.readUInt32LE(eocd+4)!==0) return invalid();
  const count = bytes.readUInt16LE(eocd+10);
  let pos = bytes.readUInt32LE(eocd+16), total = 0;
  const central = pos;
  if (count>1024 || bytes.readUInt16LE(eocd+8)!==count || pos+bytes.readUInt32LE(eocd+12)!==eocd) return invalid();
  const names = new Set<string>();
  let hasTypes = false, hasDocument = false;
  for (let i=0;i<count;i++) {
    if (pos+46>eocd || bytes.readUInt32LE(pos)!==0x02014b50) return invalid();
    const compressed=bytes.readUInt32LE(pos+20), expanded=bytes.readUInt32LE(pos+24);
    const method=bytes.readUInt16LE(pos+10), local=bytes.readUInt32LE(pos+42);
    const nameLength=bytes.readUInt16LE(pos+28), name=bytes.toString('utf8',pos+46,pos+46+nameLength);
    total+=expanded;
    if (total>32*1024*1024 || local+30>central || bytes.readUInt32LE(local)!==0x04034b50 ||
        bytes.readUInt16LE(pos+8)&1 || bytes.readUInt16LE(local+6)!==bytes.readUInt16LE(pos+8) ||
        bytes.readUInt16LE(local+8)!==method || ![0,8].includes(method) || names.has(name) ||
        name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) return invalid();
    names.add(name);
    const localName=bytes.readUInt16LE(local+26);
    const start=local+30+localName+bytes.readUInt16LE(local+28);
    if (start+compressed>central || bytes.toString('utf8',local+30,local+30+localName)!==name) return invalid();
    let data=bytes.subarray(start,start+compressed);
    if (method===8) {
      try { data=inflateRawSync(data,{maxOutputLength:Math.max(1,expanded)}); }
      catch { return invalid(); }
    }
    if (data.length!==expanded || crc32(data)!==bytes.readUInt32LE(pos+16)) return invalid();
    if (name==='[Content_Types].xml') hasTypes=data.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml');
    if (name==='word/document.xml') hasDocument=/<(?:\w+:)?document[\s>]/.test(data.toString('utf8'));
    pos+=46+nameLength+bytes.readUInt16LE(pos+30)+bytes.readUInt16LE(pos+32);
  }
  if (pos!==eocd || !hasTypes || !hasDocument) invalid();
}
export function validateContent(bytes: Buffer, mime: string) {
  if (!bytes.length) unsupported('The document is empty.');
  if (mime===types['.pdf']) {
    if (!/^%PDF-\d\.\d/.test(bytes.toString('ascii',0,8)) || !bytes.subarray(-1024).includes('%%EOF'))
      unsupported('Expected a PDF header and end marker.');
  } else if (mime===types['.docx']) validateDocx(bytes);
  else {
    try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
    catch { unsupported('Text documents must use UTF-8.'); }
    if (bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || bytes.some(b=>b<32 && ![9,10,12,13].includes(b)))
      unsupported('The document contains binary data.');
  }
}
export async function storeUpload(directory:string, stream:AsyncIterable<Uint8Array>, mime:string, limit:number) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const key=randomUUID(), path=join(directory,key);
  const file=await open(path,'wx',0o600);
  const digest=createHash('sha256');
  let size=0;
  try {
    try {
      for await (const part of stream) {
        size += part.byteLength;
        if (size > limit)
          throw new ApiError(413, 'size_limit', 'Document is too large.');
        let offset = 0;
        while (offset < part.byteLength) {
          const { bytesWritten } = await file.write(
            part,
            offset,
            part.byteLength - offset,
          );
          offset += bytesWritten;
        }
        digest.update(part);
      }
      await file.sync();
    } finally { await file.close(); }
    validateContent(await readFile(path),mime);
    return { key, size, hash:digest.digest('hex'), mimeType:mime };
  } catch (err) { await unlink(path); throw err; }
}
export type StoredBlob = Awaited<ReturnType<typeof storeUpload>>;
