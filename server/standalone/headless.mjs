import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { createConnectRouter } from './connectRouter.js';

/**
 * Run the same `/api/*` provider proxies `vite dev` / `vite preview` serve,
 * as a standalone Node process with no Vite involved.
 *
 * `CONTRIBUTING.md` is explicit that `vite preview` "is not a production
 * server" — this exists for anything that needs the provider layer running
 * unattended (a background collector, a second machine, a container) without
 * the dev-server semantics (HMR, the SPA history fallback, `vite`'s own
 * process lifecycle) that come with it.
 *
 * It listens on its own port (default 4174; `vite dev`/`vite preview` default
 * to 4173 per `.env.example`) so it can run *alongside* the normal app, not
 * instead of it — the two share the same `.gev-cache/` on disk and the same
 * `.env` keys without conflicting.
 *
 * Every provider plugin already exposes plain Connect-style middleware via
 * `configureServer(server)` / `configurePreviewServer(server)`, expecting
 * `server.middlewares` (a Connect app) and, optionally, `server.httpServer`
 * (used only to attach a `'close'` listener for graceful shutdown — see
 * `transit.js` and `vessels/ais-live.js`). `connectRouter.js` supplies a
 * standalone equivalent of the first; a real `http.Server` supplies the
 * second, so those shutdown hooks work unmodified.
 */

/**
 * `gev-key-setup` (`../standalone/key-setup.js`) backs the in-app "POWER UP"
 * panel: it writes credential files to disk from a POST body and, on save,
 * calls `server.restart()` — a real Vite dev-server method this process does
 * not provide (calling it would throw). `CONTRIBUTING.md` documents
 * `/api/setup/*` as development-only, so excluding it here is both required
 * for correctness and desirable for anything reachable outside a developer's
 * own machine: a write-capable configuration endpoint has no reason to exist
 * on a headless deployment.
 */
const DEV_ONLY_PLUGIN_NAMES = new Set(['gev-key-setup']);

/**
 * The provider plugins this server mounts: everything `localProviderPlugins`
 * returns, minus the dev-only key-setup panel. Filtering by name (rather
 * than re-listing providers here) means this stays in sync automatically as
 * `server/providers/local.js` adds new ones.
 */
export function headlessProviderPlugins() {
  return localProviderPlugins().filter(
    (plugin) => !DEV_ONLY_PLUGIN_NAMES.has(plugin.name),
  );
}

/** Liveness/readiness endpoint — for an orchestrator, and for a remote caller to check before it starts polling. */
export function healthzPlugin() {
  const startedAtMs = Date.now();
  return {
    name: 'gev-headless-healthz',
    configureServer(server) {
      server.middlewares.use('/healthz', (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ ok: true, uptimeMs: Date.now() - startedAtMs }),
        );
      });
    },
  };
}

/**
 * Build the headless API app without starting it: a router with every given
 * plugin's middleware mounted, in the given order. Returns the pieces
 * unstarted so a test can drive requests through `router.handle` directly,
 * or supply a small stub plugin list instead of the real providers (most of
 * which touch real network/API-key state as soon as they're mounted).
 *
 * @param {object} [options]
 * @param {Array<object>} [options.plugins] Defaults to healthz + every
 *   non-dev-only provider + the same `/api` 404 fallback `vite preview` uses,
 *   in that order (matching `server/standalone/vite.config.js`'s composition).
 */
export function createHeadlessApiApp({
  plugins = [
    healthzPlugin(),
    ...headlessProviderPlugins(),
    apiNotFoundPlugin(),
  ],
} = {}) {
  const router = createConnectRouter();
  const httpServer = http.createServer((req, res) => router.handle(req, res));
  const fakeViteServer = { middlewares: router, httpServer };
  const teardowns = [];
  for (const plugin of plugins) {
    plugin.configureServer?.(fakeViteServer);
    if (typeof plugin.closeBundle === 'function')
      teardowns.push(plugin.closeBundle);
  }
  async function close() {
    await new Promise((resolve) => httpServer.close(() => resolve()));
    for (const closeBundle of teardowns) {
      try {
        await closeBundle();
      } catch (err) {
        console.warn(
          '[headless-api] plugin teardown failed:',
          err?.message || err,
        );
      }
    }
  }
  return { router, httpServer, close };
}

const DEFAULT_PORT = 4174;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Start the headless API, bound to `127.0.0.1` by default — this process has
 * no auth of its own (matching the app's existing same-origin-only design;
 * see `plan.md` for the fork's separate plan to front it with auth/TLS
 * before it's ever reachable off-box). Override with `GEV_HEADLESS_PORT` /
 * `GEV_HEADLESS_HOST`.
 */
export async function startHeadlessApi({
  port = Number.parseInt(process.env.GEV_HEADLESS_PORT || '', 10) ||
    DEFAULT_PORT,
  host = process.env.GEV_HEADLESS_HOST || DEFAULT_HOST,
} = {}) {
  const app = createHeadlessApiApp();
  await new Promise((resolve) => app.httpServer.listen(port, host, resolve));
  console.log(`[headless-api] listening on http://${host}:${port}`);
  return app;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === invokedPath) {
  try {
    // Matches the app's existing "no key required to start; .env is
    // optional" posture (see CONTRIBUTING.md) rather than requiring the
    // operator to remember `node --env-file=.env`.
    process.loadEnvFile();
  } catch {
    // No .env file, or a Node version without loadEnvFile — provider keys
    // may already be set directly in the environment (e.g. Docker's
    // `env_file:`), which is a normal and supported way to run this.
  }
  const app = await startHeadlessApi();
  const shutdown = (signal) => {
    console.log(`[headless-api] ${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
