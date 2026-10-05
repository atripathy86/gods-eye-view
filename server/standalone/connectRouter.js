/**
 * Minimal Connect-compatible middleware router.
 *
 * Every provider plugin in `server/providers/*` registers its routes with
 * `server.middlewares.use('/api/thing', handler)`, relying on Vite's bundled
 * `connect` dependency for: path-prefix mounting, rewriting `req.url` to be
 * relative to the mount point before calling the handler, and first-match
 * ordering. `connect` itself is not a resolvable package outside Vite (it's
 * bundled, not a listed dependency), so `server/standalone/headless.mjs`
 * needs an equivalent to host the same plugins without Vite.
 *
 * This implements just that subset — enough to run every existing provider
 * unmodified. None of them call `next()` today (each is a terminal handler
 * for its own mount), but `next()`-based fallthrough is supported anyway so
 * a future middleware that expects to chain past itself still works.
 */

/** Split a request URL into its pathname and (query-string-including) search. */
function splitUrl(url) {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1
    ? { pathname: url, search: '' }
    : { pathname: url.slice(0, queryIndex), search: url.slice(queryIndex) };
}

/**
 * Does `url` fall under `mountPath`, and if so what's left of it once the
 * mount prefix is stripped?
 *
 * This must reproduce Vite's bundled `connect` exactly
 * (`node_modules/vite/dist/node/chunks/dep-*.js`, the `call`/`handle`
 * routing in connect's `index.js`), because the same plugins run under both
 * and a divergence fails silently: a request one server routes to a
 * provider, the other hands to the `/api` catch-all. Connect's rules are:
 *
 * - The prefix comparison is case-insensitive (`/API/OpenSky` reaches
 *   `/api/opensky`).
 * - The match must end at a boundary: end of path, `/`, **or `.`**. So
 *   `/api/gbfs.json` reaches a `/api/gbfs` mount, while `/api/gbfsXYZ` does
 *   not.
 * - `req.url` is rewritten by removing the mount's length from the front of
 *   the whole URL, query string included, and then prefixing a `/` if the
 *   remainder does not already start with one. That yields `/` for an exact
 *   match, `/?q=1` for an exact match with a query string, `/x` for
 *   `/mount/x`, and `/.json` for `/mount.json`.
 *
 * `server/apiRoutes.js` `matchApiRoute` applies the same rules to the
 * mount table, and `src/tooling/apiRoutes.test.mjs` pins them there.
 */
function mountMatch(url, mountPath) {
  if (mountPath === '/') return { matched: true, rest: url };
  const { pathname } = splitUrl(url);
  if (pathname.slice(0, mountPath.length).toLowerCase() !== mountPath.toLowerCase()) {
    return { matched: false, rest: null };
  }
  const boundary = pathname.charAt(mountPath.length);
  if (boundary !== '' && boundary !== '/' && boundary !== '.') {
    return { matched: false, rest: null };
  }
  const rest = url.slice(mountPath.length);
  return { matched: true, rest: rest.startsWith('/') ? rest : `/${rest}` };
}

function defaultNotFound(_req, res) {
  if (res.headersSent) return;
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

function defaultOnError(err, _req, res) {
  console.error(
    '[connect-router] unhandled middleware error:',
    err?.message || err,
  );
  if (res.headersSent) return;
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal' }));
}

/**
 * @param {object} [options]
 * @param {(req, res) => void} [options.notFound] Called when nothing matched.
 * @param {(err, req, res) => void} [options.onError] Called when a handler throws/rejects or calls next(err).
 */
export function createConnectRouter({
  notFound = defaultNotFound,
  onError = defaultOnError,
} = {}) {
  const stack = [];

  function use(pathOrHandler, maybeHandler) {
    if (typeof pathOrHandler === 'function') {
      stack.push({ path: '/', handle: pathOrHandler });
      return;
    }
    if (typeof maybeHandler !== 'function') {
      throw new TypeError('use(path, handler) requires a handler function');
    }
    const path =
      pathOrHandler === '/' ? '/' : pathOrHandler.replace(/\/+$/, '');
    stack.push({ path, handle: maybeHandler });
  }

  function handle(req, res) {
    const originalUrl = req.url || '/';
    let index = 0;
    function next(err) {
      if (err) {
        onError(err, req, res);
        return;
      }
      while (index < stack.length) {
        const layer = stack[index++];
        const { matched, rest } = mountMatch(originalUrl, layer.path);
        if (!matched) continue;
        req.url = rest;
        try {
          const result = layer.handle(req, res, next);
          if (result && typeof result.catch === 'function') {
            result.catch((asyncErr) => next(asyncErr));
          }
        } catch (syncErr) {
          next(syncErr);
        }
        return;
      }
      req.url = originalUrl;
      notFound(req, res);
    }
    next();
  }

  return { use, handle };
}
