import { parentPort, workerData } from 'node:worker_threads';
import { extractText, getDocumentProxy } from 'unpdf';

// Keep PDF.js CPU work off the lease/heartbeat event loop. Terminating this
// isolate on cancellation also releases the parser's document and font caches.
const pdf = await getDocumentProxy(workerData as Uint8Array);
if (pdf.numPages > 2000) {
  parentPort?.postMessage({ error: 'PDF exceeds the page limit.' });
} else {
  const { text } = await extractText(pdf, { mergePages: false });
  if (
    text.reduce((total, page) => total + page.length + 2, 0) >
    16 * 1024 * 1024
  )
    parentPort?.postMessage({
      error: 'Extracted text exceeds the size limit.',
    });
  else parentPort?.postMessage({ pages: text });
}
