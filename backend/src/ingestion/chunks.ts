import { createHash } from 'node:crypto';
import type { Extraction } from './local.js';

import { legacyStrategies } from '@rag-eval/contracts';
export type Strategy = typeof legacyStrategies[keyof typeof legacyStrategies];
export interface ChunkOptions { strategy:Strategy|keyof typeof legacyStrategies; chunkSize:number; overlap:number }
export const defaultChunks:ChunkOptions={strategy:'character-window',chunkSize:300,overlap:20};
export const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
function pointId(key:string) {
  const hex=sha256(key);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
// All offsets are half-open UTF-16 indices into normalized artifact text.
// Pages and structural blocks have hard boundaries. Pack complete units when possible.
function* blocks(text:string,strategy:Strategy) {
  let start=0, table=false;
  for (const match of text.matchAll(/[^\n]+\n?|\n/g)) {
    const line=match[0].trim(), i=match.index;
    const row=/\|.*\||\t|\S {2,}\S.* {2,}\S/.test(line);
    const heading=/^(?:#{1,6}\s|(?:\d+|[IVXLCDM]+)[.)]\s)|:$|^[A-Z][A-Z0-9 /&-]{3,}$/.test(line);
    if ((strategy==='heading-aware' && heading) || (strategy==='table-aware' && row!==table)) {
      if (start<i) yield {start,end:i,table};
      start=i;
    }
    table=row;
  }
  if (start<text.length) yield {start,end:text.length,table};
}
export interface ArtifactChunk {
  id:string; strategy:Strategy;chunkSize:number;overlap:number;ordinal:number;start:number;end:number;page:number;hash:string;content:string;
}
export function* chunkArtifact(artifactId:string, artifact:Extraction, options:ChunkOptions=defaultChunks):Generator<ArtifactChunk> {
  const strategy=Object.hasOwn(legacyStrategies,options.strategy) ? legacyStrategies[options.strategy as keyof typeof legacyStrategies] : options.strategy as Strategy;
  const {chunkSize,overlap}=options;
  if (!Number.isSafeInteger(chunkSize)||chunkSize<2||!Number.isSafeInteger(overlap)||overlap<0||overlap>=chunkSize)
    throw new RangeError('Invalid chunk size or overlap.');
  let ordinal=0;
  for (const page of artifact.pages) {
    const text=artifact.text.slice(page.start,page.end);
    const ranges=strategy==='heading-aware'||strategy==='table-aware'?blocks(text,strategy):[{start:0,end:text.length,table:false}];
    for (const block of ranges) {
      const units=block.table && strategy==='table-aware'?/\n/g:/[.!?](?:\s+|$)|\n\s*\n/g;
      const boundaries=text.slice(block.start,block.end).matchAll(units);
      let boundary=boundaries.next(), lastEnd=block.start;
      for (let start=block.start;start<block.end;) {
        const limit=Math.min(start+chunkSize,block.end);
        let end=limit;
        if (strategy!=='character-window' && limit<block.end) {
          let preferred=0;
          while (!boundary.done) {
            const position=block.start+boundary.value.index+boundary.value[0].length;
            if (position>limit) break;
            preferred=position;
            boundary=boundaries.next();
          }
          if (preferred>lastEnd) end=preferred;
        }
        if (end<block.end && /[\uDC00-\uDFFF]/.test(text[end])) end--;
        if (end<=lastEnd) {
          start=lastEnd;
          continue;
        }
        const content=text.slice(start,end);
        if (content.trim()) {
          const absolute=page.start+start,stop=page.start+end;
          yield {id:pointId(JSON.stringify(['chunk-v1',artifactId,strategy,chunkSize,overlap,absolute,stop])),
            strategy,chunkSize,overlap,ordinal:ordinal++,start:absolute,end:stop,page:page.page,hash:sha256(content),content};
        }
        if (end>=block.end) break;
        lastEnd=end;
        let next=Math.max(start+1,end-overlap);
        if (/[\uDC00-\uDFFF]/.test(text[next])) next++;
        start=next;
      }
    }
  }
}
