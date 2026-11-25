// Loaded before the real worker entry point. No request leaves the process.
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  appendFileSync(process.env.FIXTURE_CALLS, `${path}\n`);
  if (path.endsWith('/upload')) return Response.json({ parsing_job_id:'remote-123' });
  if (path.endsWith('/remote-123')) return Response.json({status: process.env.FIXTURE_HOLD ? 'PENDING' : 'SUCCESS'});
  if (path.endsWith('/remote-123/result/markdown')) return Response.json({result:{pages:[{md:'Repeated page.'},{md:'Repeated page.'}]}});
  throw new Error('Unexpected fixture request.');
};
