/**
 * Represents the parsed components of an IRI.
 * @typedef {Object} IRIComponents
 * @property {string} scheme
 * @property {string} [userinfo]
 * @property {string} [host]
 * @property {string} [port]
 * @property {string} path
 * @property {string} [query]
 * @property {string} [fragment]
 * @property {boolean} valid
 * @property {string} [error]
 */
/**
 * Parses an IRI string according to RFC 3987.
 * @param {string} iri The IRI string to parse.
 * @returns {IRIComponents} An object containing the parsed components and validity status.
 */
export function parseIRI(iri: string): IRIComponents;
/**
 * Validate a given IRI according to the given strategy.
 *
 * @param {string} iri a string that may be an IRI.
 * @param {IriValidationStrategy} strategy IRI validation strategy.
 * @return {Error | undefined} An error if the IRI is invalid, or undefined if it is valid.
 */
export function validateIri(iri: string, strategy?: Readonly<{
    /**
     * Validates the IRI according to RFC 3987 using a custom parser.
     */
    Parse: "parse";
    /**
     * Validates that the IRI has a valid scheme and does not contain any character forbidden by the Turtle specification.
     */
    Pragmatic: "pragmatic";
    /**
     * Does not validate the IRI at all.
     */
    None: "none";
}>): Error | undefined;
/**
 * Possible ways of validating an IRI.
 */
export const IriValidationStrategy: Readonly<{
    /**
     * Validates the IRI according to RFC 3987 using a custom parser.
     */
    Parse: "parse";
    /**
     * Validates that the IRI has a valid scheme and does not contain any character forbidden by the Turtle specification.
     */
    Pragmatic: "pragmatic";
    /**
     * Does not validate the IRI at all.
     */
    None: "none";
}>;
/**
 * Represents the parsed components of an IRI.
 */
export type IRIComponents = {
    scheme: string;
    userinfo?: string;
    host?: string;
    port?: string;
    path: string;
    query?: string;
    fragment?: string;
    valid: boolean;
    error?: string;
};
//# sourceMappingURL=iri.d.ts.map