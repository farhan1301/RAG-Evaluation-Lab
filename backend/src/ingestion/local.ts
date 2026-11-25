import { Worker } from 'node:worker_threads';
import type { z, pageSpan } from '@rag-eval/contracts';

export interface Extraction { text:string; pages:z.infer<typeof pageSpan>[] }
export class ParseFailure extends Error {
  constructor(message:string, readonly transient=false, readonly retryAfterMs=0) { super(message); }
}
export function fromPages(pages:string[]):Extraction {
  let offset=0;
  const normalized=pages.map(text=>text.replace(/\r\n?/g,'\n'));
  const spans=normalized.map((text,index)=>{
    const start=offset;
    offset+=text.length+2;
    return {page:index+1,start,end:start+text.length};
  });
  const text=normalized.join('\n\n');
  if (!text.trim()) throw new ParseFailure('No text extracted. For a scanned PDF, select LlamaParse to use cloud extraction.');
  if (text.length>16*1024*1024) throw new ParseFailure('Extracted text exceeds the size limit.');
  return {text,pages:spans};
}
export async function parseLocal(bytes:Buffer,mime:string,signal?:AbortSignal) {
  if (mime.startsWith('text/')) return fromPages([new TextDecoder('utf-8',{fatal:true}).decode(bytes)]);
  if (mime!=='application/pdf') throw new ParseFailure('Select LlamaParse to parse DOCX.');
  signal?.throwIfAborted();
  const source=import.meta.url.endsWith('.ts');
  const worker=new Worker(new URL(source?'./pdf-thread.ts':'./pdf-thread.js',import.meta.url),{
    workerData:new Uint8Array(bytes),execArgv:[],resourceLimits:{maxOldGenerationSizeMb:192}
  });
  const abort=()=>{void worker.terminate();};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const parsed=await new Promise<string[]>((resolve,reject)=>{
      worker.once('message',(result:{pages:string[]}|{error:string})=>{
        if ('error' in result) reject(new ParseFailure(result.error));
        else resolve(result.pages);
      });
      worker.once('error',reject);
      worker.once('exit',()=>reject(new ParseFailure('PDF extraction stopped before completion.')));
    });
    return fromPages(parsed);
  } finally {
    signal?.removeEventListener('abort',abort);
    await worker.terminate();
  }
}
