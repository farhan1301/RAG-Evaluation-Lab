// Exercise the emitted entry point and listener configuration without a socket or credentials.
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { mock } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.OPENAI_API_KEY = 'startup-fixture';
process.env.QDRANT_URL = 'http://qdrant.invalid';
const listen = mock.method(Server.prototype, 'listen', function () {
  return this;
});
try {
  await import('../backend/dist/index.js');
  assert.equal(listen.mock.callCount(), 1);
  assert.deepEqual(listen.mock.calls[0].arguments.slice(0, 2), [
    0,
    '127.0.0.1',
  ]);
  console.log(
    'Compiled backend initialized and requested its loopback listener.',
  );
} finally {
  listen.mock.restore();
}
