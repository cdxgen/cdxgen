/**
 * Remove credentials from the output of a package manager (npm, yarn, pnpm,
 * rush, pip, uv, poetry) before it is logged. A failed install names the URLs
 * it could not fetch, taken from the scanned manifest or expanded from the
 * environment, and these tools mask at most the password. The values of
 * credential-like environment variables (names ending in `_TOKEN`,
 * `_PASSWORD`, `_SECRET`, `_PAT` and the like, and index URL variables such
 * as `PIP_INDEX_URL`) are replaced by *** wherever they appear. Every URL
 * then loses its user name and password, path
 * segments that look like access tokens (as in `https://host/<token>/simple/`),
 * and its query string, since signed URLs and private tokens travel there.
 * pip prints retry lines as a bare `/path?query`, so the query rule applies
 * to any `?` run and not only inside a full URL. A fragment (`#sha256=...`) is
 * kept.
 *
 * An Error, such as the `error` of a spawn result, becomes its name and
 * message, redacted the same way.
 *
 * @param {string|Error|undefined} text Output of a package manager command
 * @returns {string|undefined} Output with credentials replaced by ***
 */
export declare function redactPackageManagerOutput(text: string | Error | undefined): string | undefined;
//# sourceMappingURL=outputRedaction.d.ts.map