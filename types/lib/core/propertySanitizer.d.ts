/**
 * Remove the parts of every URL in a text that can carry a credential: the
 * userinfo before `@`, the query string and the fragment. Any scheme is
 * handled, such as `sparse+https://`, `ssh://` or `jdbc:postgresql://`.
 *
 * A network-path reference (RFC 3986 section 4.2) has no scheme, as in
 * `--registry=//user:password@host/npm/`. Two slashes are read as one when
 * they start the text or follow white space, `=`, a quote, `(`, `,` or `<`,
 * and the userinfo before `@` holds a `:`. A comment such as `// see
 * user@example.com` or a bare `//name@host` is left as written.
 *
 * A userinfo or query may hold `;`, `,`, quotes and other characters that
 * also separate the items of a list, so none of them ends a URL early. The
 * authority and path of a URL end at white space, `?`, `#` or the scheme of
 * the next URL. A query or fragment ends at white space or at the scheme of a
 * next URL that follows a list separator. The separators, quotes, periods and
 * closing brackets at its end are kept, except a bracket that closes one
 * opened inside the query, as in `?token={t}`. A password that holds white
 * space, `/`, `?` or `#` cannot be told apart from the text around it and is
 * not recognised.
 *
 * The text is scanned once, so the work stays linear in its length.
 *
 * @param {unknown} value Text that may contain URLs
 * @returns {string} The text with URL userinfo, queries and fragments removed
 */
export declare function stripUrlCredentials(value: unknown): string;
/**
 * Recursively sanitize structured values before embedding them in a BOM.
 *
 * @param {unknown} value structured value
 * @returns {unknown} sanitized value
 */
export declare function sanitizeStructuredValueForBom(value: unknown): unknown;
/**
 * Sanitize free text, such as a name or a command line copied from a scanned
 * file, before it is embedded in a BOM: URL userinfo, queries and fragments
 * are removed and known token shapes are redacted.
 *
 * @param {unknown} value Text to sanitize
 * @returns {string} sanitized text
 */
export declare function sanitizeBomText(value: unknown): string;
/**
 * Sanitize a URL value for safe BOM emission.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export declare function sanitizeBomUrl(value: string): string;
/**
 * Sanitize a service endpoint URL, such as an MCP server URL, for safe BOM
 * emission. Besides what {@link sanitizeBomUrl} removes, `;name=value` path
 * parameters such as `;jsessionid=` and `;token=` are dropped and the path
 * ends before the first segment holding a token shape the BOM sanitizer
 * recognises, because endpoints that authenticate by their path carry the
 * credential there. No `[redacted]` marker is spliced in, as
 * `services[].endpoints[]` must stay an iri-reference. A value that is not
 * a URL with a path is returned as {@link sanitizeBomUrl} returns it.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export declare function sanitizeBomEndpointUrl(value: string): string;
/**
 * Percent-encode what an RFC 3986 URI reference cannot hold as it is, so a
 * route template or URL can be emitted where CycloneDX expects an
 * iri-reference, such as `services[].endpoints[]`. The braces of a route
 * template, spaces, `<>`, `[]` outside an IPv6 host, `|`, `^`, non-ASCII
 * characters and a `%` that starts no escape are encoded:
 * `/users/{id}` becomes `/users/%7Bid%7D`. The scheme and authority of an
 * absolute URL are kept as written, the query and fragment stay a query and
 * fragment, and existing escapes are kept, so encoding twice changes
 * nothing. Nothing is removed; strip credentials with {@link sanitizeBomUrl}
 * first.
 *
 * @param {unknown} value Route template, path or URL
 * @returns {string} The encoded reference
 */
export declare function encodeUriReference(value: unknown): string;
/**
 * Whether a value carries a token shape the BOM sanitizer redacts: cloud
 * access keys, bearer tokens, GitHub, Slack and npm tokens, JWTs and the
 * like. Callers that cannot splice a `[redacted]` marker into the value, such
 * as a URL path segment, use it to drop the value instead.
 *
 * @param {unknown} value Value to check
 * @returns {boolean} true when the value holds an inline credential
 */
export declare function hasInlineCredential(value: unknown): boolean;
/**
 * Sanitize a property value before serializing it into BOM properties.
 *
 * @param {string} name property name
 * @param {unknown} value property value
 * @returns {string|unknown} sanitized property value
 */
export declare function sanitizeBomPropertyValue(name: string, value: unknown): string | unknown;
/**
 * Redact credential values passed as literal arguments in a command line
 * copied from a CI file or a build script: the value after flags such as
 * `--password`, `--token` or `--api-key` (spaced or with `=`), curl's
 * `-u user:password`, `login -p` of container registry clients, a password
 * attached to the `-p` of the MySQL clients, credential-bearing header
 * values such as `Authorization:`, and `NAME=value` assignments whose name
 * marks a credential. The executable and the other arguments are kept, and
 * a value that is a variable reference such as `$TOKEN` or
 * `${{ secrets.TOKEN }}` is kept because it holds no secret.
 *
 * The line is scanned once, so the work stays linear in its length.
 *
 * @param {unknown} value Command line
 * @returns {string} The command line with credential values redacted
 */
export declare function redactCommandCredentials(value: unknown): string;
/**
 * Remove what can carry a credential from a reference URL copied from a
 * scanned manifest, such as a homepage, repository, issue tracker or
 * download URL: the userinfo (except the `git@` of an SSH URL), the query
 * string, and a fragment that holds `=` or a token shape. A fragment naming
 * a git ref, as in `git+https://host/repo.git#v1.2.0`, is kept. The URL is
 * not otherwise rewritten, so a value without credentials comes back as it
 * was. A network-path reference such as `//user:password@host/path` is
 * handled like a URL with a scheme. Any other value without `://` is
 * returned unchanged, except that an scp-like `user:password@host:path`
 * loses its userinfo.
 *
 * @param {unknown} value URL text
 * @returns {string} The URL without credentials
 */
export declare function sanitizeBomReferenceUrl(value: unknown): string;
//# sourceMappingURL=propertySanitizer.d.ts.map