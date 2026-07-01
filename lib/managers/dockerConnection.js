import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { URL } from "node:url";

import { Client, interceptors, Pool, request as undiciRequest } from "undici";

/**
 * undici-backed connection helper for talking to the local Docker / Podman
 * daemon (over a unix socket) or a remote daemon (over TCP/TLS). This replaces
 * cdxgen's previous use of `got` for daemon communication.
 *
 * @module dockerConnection
 */

// Retry policy for transient Docker/Podman daemon and registry failures. Mirrors
// the retry behaviour cdxgen previously configured on the got client.
export const DAEMON_RETRY_OPTIONS = {
  maxRetries: 3,
  methods: ["GET", "POST", "HEAD"],
  statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
};

/**
 * Parse a got-style Docker daemon `prefixUrl` into the pieces undici needs.
 * Unix socket URLs use the form `http://unix:/path/to/socket:`; anything else
 * is treated as a regular TCP/TLS base URL.
 *
 * @param {string} prefixUrl got-style prefix URL for the daemon endpoint.
 * @returns {{socketPath: (string|undefined), baseUrl: string}} The unix socket
 *   path (when applicable) and the origin to use as the undici base URL.
 */
export const parseDaemonPrefixUrl = (prefixUrl) => {
  const unixMarker = "unix:";
  const markerIndex = prefixUrl.indexOf(unixMarker);
  if (markerIndex !== -1) {
    // Everything between `unix:` and the trailing `:` is the socket path.
    let socketPath = prefixUrl.slice(markerIndex + unixMarker.length);
    if (socketPath.endsWith(":")) {
      socketPath = socketPath.slice(0, -1);
    }
    return { socketPath, baseUrl: "http://localhost" };
  }
  return { socketPath: undefined, baseUrl: new URL(prefixUrl).origin };
};

/**
 * Create a connection to the Docker / Podman daemon backed by undici. The
 * returned object mimics the small slice of the got client that cdxgen relies
 * on: a `request()` method returning a parsed body and a synchronous `stream()`
 * method returning a readable image tar stream.
 *
 * @param {string} prefixUrl got-style daemon prefix URL (unix socket or TCP).
 * @param {Object} [headers] Default headers (e.g. `X-Registry-Auth`) to send.
 * @param {Object} [https] TLS material for remote daemons
 *   (`{ certificate, key, rejectUnauthorized }`).
 * @returns {Object} Connection object with `request`, `stream`, `close`,
 *   `prefixUrl` and `baseUrl`.
 */
export const createDaemonConnection = (prefixUrl, headers, https) => {
  const { socketPath, baseUrl } = parseDaemonPrefixUrl(prefixUrl);
  const connect = {};
  if (https?.certificate) {
    connect.cert = https.certificate;
  }
  if (https?.key) {
    connect.key = https.key;
  }
  if (https?.rejectUnauthorized === false) {
    connect.rejectUnauthorized = false;
  }
  const hasConnectOptions = Object.keys(connect).length > 0;
  const baseDispatcher = socketPath
    ? new Client(baseUrl, {
        socketPath,
        ...(hasConnectOptions ? { connect } : {}),
      })
    : new Pool(baseUrl, hasConnectOptions ? { connect } : undefined);
  const dispatcher = baseDispatcher.compose(
    interceptors.retry(DAEMON_RETRY_OPTIONS),
  );
  const toUrl = (path) => `${baseUrl}/${String(path).replace(/^\//, "")}`;
  const mergedHeaders = (extra) => ({ ...(headers || {}), ...(extra || {}) });
  return {
    prefixUrl,
    baseUrl,
    /**
     * Send a request to the daemon and resolve to the response body.
     *
     * @param {string} path API path relative to the daemon base URL.
     * @param {Object} [opts] `{ method, headers, body, responseType }`.
     * @returns {Promise<Object|Buffer>} Parsed JSON for `responseType: "json"`,
     *   otherwise a Buffer.
     */
    async request(path, opts = {}) {
      const method = (opts.method || "GET").toUpperCase();
      const res = await undiciRequest(toUrl(path), {
        method,
        headers: mergedHeaders(opts.headers),
        body: opts.body,
        dispatcher,
      });
      if (res.statusCode >= 400) {
        await res.body.arrayBuffer();
        const error = new Error(
          `The container daemon responded with HTTP ${res.statusCode}.`,
        );
        error.statusCode = res.statusCode;
        throw error;
      }
      if (opts.responseType === "json") {
        return await res.body.json();
      }
      return Buffer.from(await res.body.arrayBuffer());
    },
    /**
     * Return a readable stream of the response body for the given path. The
     * stream is returned synchronously so it can be handed directly to
     * `stream.pipeline`.
     *
     * @param {string} path API path relative to the daemon base URL.
     * @returns {import("node:stream").Readable} Readable response body stream.
     */
    stream(path) {
      const passThrough = new PassThrough();
      undiciRequest(toUrl(path), { method: "GET", headers, dispatcher })
        .then((res) => {
          if (res.statusCode >= 400) {
            passThrough.destroy(
              new Error(
                `The container daemon responded with HTTP ${res.statusCode}.`,
              ),
            );
            return;
          }
          res.body.pipe(passThrough);
        })
        .catch((error) => passThrough.destroy(error));
      return passThrough;
    },
    /**
     * Close the underlying undici dispatcher, releasing pooled sockets.
     *
     * @returns {Promise<void>}
     */
    async close() {
      try {
        await baseDispatcher.close();
      } catch {
        // ignore
      }
    },
  };
};
