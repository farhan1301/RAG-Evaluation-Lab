import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Router, type Request } from 'express';
import * as c from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import type { Datasets } from '../db/datasets.js';
import { ApiError } from '../errors.js';
import { blobDirectory, mediaType, storeUpload } from '../ingestion/blobs.js';
import { expected, parse } from './routes.js';

export function requestKey(req:Request) {
  return parse(c.z.string().trim().min(1).max(200).optional(),req.get('idempotency-key'))??null;
}
export function checkParser(parser:c.Parser,mime:string,cloud:boolean) {
  if (parser==='llama-parse' && !cloud) throw new ApiError(422,'missing_capability','Configure LlamaParse to use the cloud parser.');
  if (parser==='local' && !mime.startsWith('text/') && mime!=='application/pdf') throw new ApiError(415,'unsupported_media','DOCX requires the LlamaParse cloud parser.');
}
export function uploadsRouter(datasets:Datasets,config:Config) {
  const router=Router();
  router.post('/datasets/:id/documents',async(req,res)=>{
    const id=parse(c.id,req.params.id), rev=expected(req), key=requestKey(req);
    const {name,parser}=parse(c.uploadQuery,req.query);
    const mime=mediaType(name,(req.get('content-type')??'').split(';')[0].trim().toLowerCase());
    checkParser(parser,mime,config.capabilities.cloudParser);
    if (req.get('content-encoding') && req.get('content-encoding')!=='identity')
      throw new ApiError(415,'unsupported_media','Upload unencoded file bytes.');
    const limit=config.env.DOCUMENT_LIMIT_BYTES;
    if (Number(req.get('content-length'))>limit) throw new ApiError(413,'size_limit','Document is too large.');
    const directory=blobDirectory(config);
    const blob=await storeUpload(directory,req.iterator({destroyOnReturn:false}),mime,limit).catch(err=>{req.resume();throw err;});
    let keep=false;
    try {
      const {reused,...result}=datasets.addUpload(id,rev,name,blob,parser,key);
      keep=!reused;
      res.location(`/api/v1/jobs/${result.jobId}`).set('ETag',`"${result.dataset.revision}"`).status(202).json(result);
    } finally {if(!keep) await unlink(join(directory,blob.key));}
  });
  return router;
}
