// Exercise the emitted entry point and listener configuration without a socket or credentials.
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { mock } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DATABASE_PATH = ':memory:';
for (const key of Object.keys(process.env)) {
  if (/^(OPENAI_|LOCAL_EMBED_|QDRANT_|LLAMA_)/.test(key))
    delete process.env[key];
}
const listen = mock.method(Server.prototype, 'listen', function () {
  return this;
});
const close = mock.method(Server.prototype, 'close', function (callback) {
  callback();
  return this;
});
try {
  await import('../backend/dist/index.js');
  assert.equal(listen.mock.callCount(), 1);
  assert.deepEqual(listen.mock.calls[0].arguments.slice(0, 2), [
    0,
    '127.0.0.1',
  ]);
  process.emit('SIGTERM');
  assert.equal(close.mock.callCount(), 1);
  console.log(
    'Compiled backend initialized and requested its loopback listener and drained on SIGTERM.',
  );
} finally {
  listen.mock.restore();
  close.mock.restore();
}
