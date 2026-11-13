import { isAllowedHttpHost } from "../core/activity.js";
export { isAllowedHttpHost };
/**
 * Method to safely parse value passed via the query string or body.
 *
 * @param {string|number|Array<string|number>} raw
 * @returns {string|number|boolean|Array<string|number|boolean>}
 * @throws {TypeError} if raw (or any array element) isn’t string or number
 */
export declare function parseValue(raw: string | number | Array<string | number>): string | number | boolean | Array<string | number | boolean>;
/**
 * Parses allowed query/body parameters into a typed options object.
 * Query parameters take priority over body parameters. Handles the
 * `type` → `projectType` rename, lifecycle-based `installDeps` defaulting,
 * and profile option expansion.
 *
 * @param {Object} q Parsed query string key/value map
 * @param {Object} [body={}] Parsed request body key/value map
 * @param {Object} [options={}] Seed options object to merge results into
 * @returns {Object} Populated options object
 */
export declare function parseQueryString(q: Object, body?: Object, options?: Object): Object;
/**
 * Check request options that the server must refuse outright.
 *
 * @param {Object} reqOptions Options parsed from the request
 * @param {Object} operatorOptions Options the server was started with
 * @returns {Object|null} Error object with status, error and details, or null
 */
export declare function validateRequestOptions(reqOptions: Object, operatorOptions?: Object): Object | null;
/**
 * Extracts query parameters from an incoming HTTP request object.
 * Handles repeated keys by collecting their values into an array.
 * Returns an empty object if the URL cannot be parsed.
 *
 * @param {Object} req Node.js/connect HTTP request object
 * @returns {Object} Key/value map of query parameters from the request URL
 */
export declare function getQueryParams(req: Object): Object;
/**
 * Serialize the BOM response body before any status line is written, so a
 * failure (for example a BOM larger than the maximum string length) can still
 * be answered with an error status.
 *
 * @param {Object|string|undefined} responseBomJson BOM object or pre-rendered string
 * @returns {string|undefined} Serialized body, an empty string when there is no
 *   BOM, or undefined when serialization fails
 */
export declare function serializeBomResponse(responseBomJson: Object | string | undefined): string | undefined;
/**
 * Configure timeout and keepAlive values on the cdxgen HTTP server.
 *
 * @param {import("node:http").Server} cdxgenServer HTTP server instance to configure
 * @returns {void}
 */
declare const configureServer: (cdxgenServer: import("node:http").Server) => void;
/**
 * Boot the cdxgen HTTP server.
 *
 * Performs startup security checks (secure mode, host exposure, privileged
 * ports), validates the configured port, registers routes, and begins
 * listening for BOM generation requests.
 *
 * @param {object} options CLI options including `serverHost` and `serverPort`
 * @returns {void}
 */
declare const start: (options: object) => void;
export { configureServer, start };
//# sourceMappingURL=server.d.ts.map