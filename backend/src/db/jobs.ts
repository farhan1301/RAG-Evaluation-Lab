import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { job, jobEvent, chunkOptions, chunkRow, type Parser, z, pageSpan } from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import { transaction } from './database.js';
import type { Extraction } from '../ingestion/local.js';
import {
  defaultChunks,
  sha256,
  type ArtifactChunk,
} from '../ingestion/chunks.js';

const fields='id, version_id AS versionId, parser, state, stage, attempt, message, parent_id AS parentId, artifact_id AS artifactId';
export interface Lease {id:string;token:number}
export class LostLease extends Error {}
export const attempts=4;
const duration=10*60*1000;

export class Jobs {
  constructor(private readonly db:DatabaseSync, readonly now=Date.now, readonly leaseMs=30000) {}
  get(id:string) {return job.parse(this.db.prepare(`SELECT ${fields} FROM jobs WHERE id=?`).get(id)??missing());}
  events(id:string,after:number) {
    this.get(id);
    return this.db.prepare('SELECT seq,state,stage,message,time FROM job_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 100').all(id,after).map(row=>jobEvent.parse(row));
  }
  private event(id:string) {
    this.db.prepare('INSERT INTO job_events(job_id,state,stage,message,time) SELECT id,state,stage,message,? FROM jobs WHERE id=?').run(this.now(),id);
  }
  replay(key:string|null,hash:string) {
    if (!key) return;
    const row=this.db.prepare('SELECT id,request_hash FROM jobs WHERE request_key=?').get(key);
    if (row && row.request_hash!==hash) throw new ApiError(409,'conflict','Idempotency key was used with different input.');
    if (row) return String(row.id);
  }
  // Caller owns the write transaction, including document/revision creation.
  enqueue(version:string,parser:Parser,key:string|null=null,hash:string|null=null,parent:string|null=null) {
    const id=randomUUID(), now=this.now();
    this.db.prepare("INSERT INTO jobs(id,version_id,parser,state,stage,eligible,deadline,parent_id,request_key,request_hash) VALUES (?,?,?,'queued','waiting',?,?,?,?,?)")
      .run(id,version,parser,now,now+duration,parent,key,hash);
    this.event(id);
    return id;
  }
  retry(id:string) {
    return transaction(this.db,()=>{
      const previous=this.get(id);
      const child=this.db.prepare('SELECT id FROM jobs WHERE parent_id=?').get(id);
      if (child) return this.get(String(child.id));
      if (!['failed','cancelled'].includes(previous.state)) throw new ApiError(409,'conflict','Only a failed or cancelled job can be retried.');
      const next=this.enqueue(previous.versionId,previous.parser,null,null,id);
      this.db.prepare('UPDATE jobs SET chunk_config=(SELECT chunk_config FROM jobs WHERE id=?) WHERE id=?').run(id,next);
      // Resume confirmed remote work unless the provider rejected the job itself.
      if (!this.step(id,'remote-failed'))
        this.db.prepare("INSERT INTO job_steps SELECT ?,stage,value FROM job_steps WHERE job_id=? AND stage IN ('remote-id','poll-complete','extraction')").run(next,id);
      return this.get(next);
    });
  }
  cancel(id:string) {
    return transaction(this.db,()=>{
      const j=this.get(id);
      if (j.state==='queued' || j.state==='running') {
        this.db.prepare('UPDATE jobs SET state=?,message=NULL WHERE id=?').run(j.state==='queued'?'cancelled':'cancellation_requested',id);
        this.event(id);
      }
      return this.get(id);
    });
  }
  presence() {this.db.prepare('INSERT OR REPLACE INTO worker_presence VALUES (1,?)').run(this.now());}
  online() {return !!this.db.prepare('SELECT 1 FROM worker_presence WHERE seen>=?').get(this.now()-this.leaseMs);}
  claim() {
    return transaction(this.db,()=>{
      const now=this.now();
      for (const row of this.db.prepare(`SELECT id,state FROM jobs WHERE state IN ('queued','running','cancellation_requested') AND
        (deadline<=? OR (state!='queued' AND expires<=? AND (attempt>=? OR state='cancellation_requested')))`).all(now,now,attempts)) {
        const cancelled=row.state==='cancellation_requested';
        this.db.prepare('UPDATE jobs SET state=?,message=? WHERE id=?').run(cancelled?'cancelled':'failed',cancelled?null:'Job deadline or attempt limit reached.',row.id);
        this.event(String(row.id));
      }
      const row=this.db.prepare(`SELECT id FROM jobs WHERE (state='queued' AND eligible<=?) OR (state='running' AND expires<=?) ORDER BY eligible,rowid LIMIT 1`).get(now,now);
      if (!row) return;
      const id=String(row.id);
      const lease=this.db.prepare("UPDATE jobs SET state='running',message=NULL,attempt=attempt+1,token=token+1,expires=? WHERE id=? RETURNING token").get(now+this.leaseMs,id);
      this.event(id);
      return {...this.get(id),token:Number(lease?.token)};
    });
  }
  private guard(l:Lease) {
    const row=this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?").get(l.id,l.token,this.now(),this.now());
    if (!row) throw new LostLease();
  }
  heartbeat(l:Lease) {
    return transaction(this.db,()=>{
      const now=this.now();
      const cancelled=this.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=? AND token=? AND state='cancellation_requested' AND expires>?").run(l.id,l.token,now);
      if (cancelled.changes) this.event(l.id);
      else if (this.db.prepare("UPDATE jobs SET expires=? WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?").run(now+this.leaseMs,l.id,l.token,now,now).changes) return true;
      return false;
    });
  }
  step(id:string,stage:string) {
    return this.db.prepare('SELECT value FROM job_steps WHERE job_id=? AND stage=?').get(id,stage)?.value as string|undefined;
  }
  checkpoint(l:Lease,stage:string,value='done') {
    transaction(this.db,()=>{
      this.guard(l);
      this.db.prepare('INSERT OR IGNORE INTO job_steps VALUES (?,?,?)').run(l.id,stage,value);
      this.db.prepare('UPDATE jobs SET stage=? WHERE id=?').run(stage,l.id);
      this.event(l.id);
    });
  }
  chunkOptions(id:string) {
    const value=this.db.prepare('SELECT chunk_config FROM jobs WHERE id=?').get(id)?.chunk_config;
    return value?chunkOptions.parse(JSON.parse(String(value))):chunkOptions.parse(defaultChunks);
  }
  requestChunks(version:string,options:z.infer<typeof chunkOptions>,key:string|null) {
    return transaction(this.db,()=>{
      const signature=sha256(JSON.stringify(['chunks',version,options]));
      const previous=this.replay(key,signature);
      if (previous) return this.get(previous);
      const source=this.db.prepare('SELECT is_text FROM document_versions WHERE id=?').get(version)??missing();
      const parsed=this.db.prepare('SELECT parser,artifact_id FROM jobs WHERE version_id=? AND chunk_config IS NULL ORDER BY rowid DESC LIMIT 1').get(version);
      if ((parsed || !source.is_text) && !parsed?.artifact_id) throw new ApiError(409,'conflict','Finish parsing this document first.');
      const id=this.enqueue(version,parsed?.parser==='llama-parse'?'llama-parse':'local',key,signature);
      this.db.prepare('UPDATE jobs SET chunk_config=? WHERE id=?').run(JSON.stringify(options),id);
      if (parsed?.artifact_id) this.db.prepare("INSERT INTO job_steps VALUES (?,'extraction',?)").run(id,parsed.artifact_id);
      return this.get(id);
    });
  }
  chunks(id:string,after:number) {
    const job=this.get(id);
    if (!job.artifactId || job.state!=='succeeded') throw new ApiError(409,'conflict','Job is not complete.');
    const options=this.chunkOptions(id);
    const rows=this.db.prepare('SELECT id,ordinal,start,end,page FROM chunks WHERE artifact_id=? AND strategy=? AND chunk_size=? AND overlap=? AND ordinal>? ORDER BY ordinal LIMIT 101')
      .all(job.artifactId,options.strategy,options.chunkSize,options.overlap,after);
    const artifact=this.artifact(job.artifactId)??missing();
    const items=rows.slice(0,100).map(row=>chunkRow.parse({...row,content:artifact.text.slice(Number(row.start),Number(row.end))}));
    return {items,nextCursor:rows.length>100?String(items[99].ordinal):null};
  }
  source(version:string) {
    const row=this.db.prepare('SELECT name,mime_type,hash,blob_key,bytes FROM document_versions WHERE id=?').get(version)??missing();
    return {name:String(row.name),mime:String(row.mime_type),hash:String(row.hash),blobKey:row.blob_key as string|null,inline:row.bytes as Uint8Array};
  }
  artifact(id:string):Extraction|undefined {
    const row=this.db.prepare('SELECT text,pages FROM parse_artifacts WHERE id=?').get(id);
    if(row) return {text:String(row.text),pages:z.array(pageSpan).parse(JSON.parse(String(row.pages)))};
  }
  saveExtraction(l:Lease,id:string,hash:string,version:string,result:Extraction) {
    transaction(this.db,()=>{
      this.guard(l);
      this.db.prepare('INSERT OR IGNORE INTO parse_artifacts VALUES (?,?,?,?,?)').run(id,hash,version,result.text,JSON.stringify(result.pages));
      this.db.prepare("INSERT OR IGNORE INTO job_steps VALUES (?,'extraction',?)").run(l.id,id);
      this.db.prepare("UPDATE jobs SET stage='chunking' WHERE id=?").run(l.id);
      this.event(l.id);
    });
  }
  saveChunks(l:Lease,artifact:string,rows:ArtifactChunk[]) {
    transaction(this.db,()=>{
      this.guard(l);
      const insert=this.db.prepare('INSERT OR IGNORE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const row of rows) insert.run(row.id,artifact,row.strategy,row.chunkSize,row.overlap,row.ordinal,row.start,row.end,row.page,row.hash);
    });
  }
  finish(l:Lease,artifact:string) {
    transaction(this.db,()=>{
      this.guard(l);
      this.db.prepare("UPDATE jobs SET state='succeeded',stage='complete',artifact_id=? WHERE id=?").run(artifact,l.id);
      this.event(l.id);
    });
  }
  fail(l:Lease,message:string,delay?:number,uploadRejected=false) {
    transaction(this.db,()=>{
      this.guard(l);
      if(uploadRejected) this.db.prepare("DELETE FROM job_steps WHERE job_id=? AND stage='upload-started'").run(l.id);
      const eligible=this.now()+Math.min(delay??0,duration);
      this.db.prepare(`UPDATE jobs SET state=CASE WHEN ? AND attempt<? AND deadline>? THEN 'queued' ELSE 'failed' END,message=?,eligible=? WHERE id=?`)
        .run(Number(delay!==undefined),attempts,eligible,message,eligible,l.id);
      this.event(l.id);
    });
  }
}
