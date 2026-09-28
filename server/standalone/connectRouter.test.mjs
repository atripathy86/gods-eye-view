import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectRouter } from './connectRouter.js';

function mockReqRes(url, method = 'GET') {
  const req = { url, method, headers: {} };
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  return { req, res };
}

test('exact mount match rewrites req.url to root, keeping the query string', () => {
  const router = createConnectRouter();
  let seenUrl = null;
  router.use('/api/opensky', (req, res) => {
    seenUrl = req.url;
    res.writeHead(200, {});
    res.end('ok');
  });
  const { req, res } = mockReqRes('/api/opensky?lat=30.2&lon=-97.7');
  router.handle(req, res);
  assert.equal(seenUrl, '/?lat=30.2&lon=-97.7');
  assert.equal(res.statusCode, 200);
});

test('deeper path mount strips only the mount prefix', () => {
  const router = createConnectRouter();
  let seenUrl = null;
  router.use('/api/cctv', (req, res) => {
    seenUrl = req.url;
    res.writeHead(200, {});
    res.end('ok');
  });
  const { req, res } = mockReqRes('/api/cctv/sources');
  router.handle(req, res);
  assert.equal(seenUrl, '/sources');
});

test('first matching mount wins; a later, broader mount never runs', () => {
  const router = createConnectRouter();
  const hits = [];
  router.use('/api/tomtom', (_req, res) => {
    hits.push('tomtom');
    res.writeHead(200, {});
    res.end('specific');
  });
  router.use('/api', (_req, res) => {
    hits.push('catch-all');
    res.writeHead(404, {});
    res.end('fallback');
  });
  const { req, res } = mockReqRes('/api/tomtom/status');
  router.handle(req, res);
  assert.deepEqual(hits, ['tomtom']);
  assert.equal(res.body, 'specific');
});

test('an unmatched path reaches the broader mount registered after it', () => {
  const router = createConnectRouter();
  router.use('/api/tomtom', (_req, res) => {
    res.writeHead(200, {});
    res.end('specific');
  });
  router.use('/api', (_req, res) => {
    res.writeHead(404, {});
    res.end('fallback');
  });
  const { req, res } = mockReqRes('/api/unknown-thing');
  router.handle(req, res);
  assert.equal(res.body, 'fallback');
});

test('nothing matches at all: default 404 JSON', () => {
  const router = createConnectRouter();
  const { req, res } = mockReqRes('/api/anything');
  router.handle(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
});

test('a handler that throws synchronously is turned into a 500, not an uncaught exception', () => {
  const router = createConnectRouter();
  router.use('/api/broken', () => {
    throw new Error('boom');
  });
  const { req, res } = mockReqRes('/api/broken');
  assert.doesNotThrow(() => router.handle(req, res));
  assert.equal(res.statusCode, 500);
});

test('a handler that rejects asynchronously is also turned into a 500', async () => {
  const router = createConnectRouter();
  router.use('/api/broken-async', async () => {
    throw new Error('boom');
  });
  const { req, res } = mockReqRes('/api/broken-async');
  router.handle(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 500);
});

test('calling next() falls through to the next matching mount', () => {
  const router = createConnectRouter();
  const hits = [];
  router.use('/api/thing', (_req, _res, next) => {
    hits.push('first');
    next();
  });
  router.use('/api', (_req, res) => {
    hits.push('second');
    res.writeHead(200, {});
    res.end('done');
  });
  const { req, res } = mockReqRes('/api/thing');
  router.handle(req, res);
  assert.deepEqual(hits, ['first', 'second']);
  assert.equal(res.body, 'done');
});
