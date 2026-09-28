import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeadlessApiApp,
  healthzPlugin,
  headlessProviderPlugins,
} from './headless.mjs';
import { apiNotFoundPlugin } from './api-not-found.js';
import { localProviderPlugins } from '../providers/local.js';

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

function stubProvider(name, path, body) {
  return {
    name,
    configureServer(server) {
      server.middlewares.use(path, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    },
  };
}

test('headlessProviderPlugins excludes only the dev-only key-setup panel', () => {
  const all = localProviderPlugins();
  const headless = headlessProviderPlugins();
  assert.equal(headless.length, all.length - 1);
  assert.ok(!headless.some((plugin) => plugin.name === 'gev-key-setup'));
  const removedNames = new Set(all.map((p) => p.name)).difference(
    new Set(headless.map((p) => p.name)),
  );
  assert.deepEqual([...removedNames], ['gev-key-setup']);
});

test('/healthz responds ok without mounting any provider plugin', async () => {
  const app = createHeadlessApiApp({ plugins: [healthzPlugin()] });
  const { req, res } = mockReqRes('/healthz');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeMs, 'number');
  await app.close();
});

test('a stub provider mount is reached before the /api 404 fallback', async () => {
  const app = createHeadlessApiApp({
    plugins: [
      stubProvider('stub', '/api/stub', { hit: true }),
      apiNotFoundPlugin(),
    ],
  });
  const { req, res } = mockReqRes('/api/stub/anything');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { hit: true });
  await app.close();
});

test('an unregistered /api path falls through to the same 404 vite preview uses', async () => {
  const app = createHeadlessApiApp({
    plugins: [
      stubProvider('stub', '/api/stub', { hit: true }),
      apiNotFoundPlugin(),
    ],
  });
  const { req, res } = mockReqRes('/api/not-a-real-route');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
  await app.close();
});

test('close() tears down cleanly even when the server was never started', async () => {
  const app = createHeadlessApiApp({ plugins: [] });
  await assert.doesNotReject(() => app.close());
});
