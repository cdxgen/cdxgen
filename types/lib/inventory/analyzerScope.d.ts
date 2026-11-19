/**
 * Flatten a scalar or nested-array value into a single-level array of
 * individual resolved values.
 *
 * @param {*} value Scalar, array, or nested array of values.
 * @returns {Array} Flat array of individual values (empty for undefined).
 */
export declare const toResolvedValueArray: (value: any) => any[];
/**
 * Build a stable dedup key for a resolved value. Primitives and small objects
 * are keyed by a string that is prefixed with the type so that distinct types
 * never collide. Larger objects are their own key, because the size of their
 * serialized form is not bounded by the size of the source.
 *
 * @param {*} value Resolved value to key.
 * @returns {string|object} Stable dedup key (e.g. "string:abc", "object:{...}", or the object itself).
 */
export declare const resolvedValueKey: (value: any) => string | object;
/**
 * Merge one or more scalar/array resolved values into a single deduplicated
 * value, returning a scalar when only one unique value remains.
 *
 * @param {...*} values Resolved values to merge.
 * @returns {*} Merged scalar, deduplicated array, or undefined when empty.
 */
export declare const mergeResolvedValues: (...values: any[]) => any;
/**
 * Filter the resolved values within a scalar/array by a predicate and re-merge
 * the surviving values.
 *
 * @param {*} value Scalar or array of resolved values.
 * @param {(candidate: *) => boolean} predicate Predicate function to retain values.
 * @returns {*} Re-merged filtered result.
 */
export declare const filterResolvedValues: (value: any, predicate: (candidate: any) => boolean) => any;
/**
 * Determine whether every resolved value within a scalar/array satisfies the
 * given predicate.
 *
 * @param {*} value Scalar or array of resolved values.
 * @param {(candidate: *) => boolean} predicate Predicate function to test.
 * @returns {boolean} True when there is at least one value and all satisfy the predicate.
 */
export declare const hasOnlyResolvedValues: (value: any, predicate: (candidate: any) => boolean) => boolean;
/**
 * Read a named property from a statically-resolved object or array value,
 * mapping across array elements when the value is an array.
 *
 * @param {object|Array} objectValue Resolved object or array value.
 * @param {string} propertyName Property name to read.
 * @returns {*} The property value, a merged array of results, or undefined.
 */
export declare const getStaticObjectProperty: (objectValue: object | any[], propertyName: string) => any;
/**
 * Derive narrowed identifier-to-value bindings from a conditional AST node,
 * given whether the branch was taken.
 *
 * Handles parenthesized/type-cast wrappers, logical (&&, ||) and unary (!)
 * expressions, and equality (==, ===, !=, !==) comparisons between an
 * identifier and a literal.
 *
 * @param {object} astNode The conditional AST node to analyze.
 * @param {boolean} branchTaken Whether the consequent (true) or alternate (false) branch applies.
 * @param {(node: object) => (string|undefined)} getLiteralStringValue Function to extract a literal string from an AST node.
 * @returns {Map<string, *>|undefined} Map of identifier name to narrowed value, or undefined.
 */
export declare const deriveStaticNarrowingsFromCondition: (astNode: object, branchTaken: boolean, getLiteralStringValue: (node: object) => (string | undefined)) => Map<string, any> | undefined;
/**
 * Best-effort static resolution of an AST node to a concrete value.
 *
 * Resolves literals, identifiers (via the provided name→value map),
 * conditional and logical expressions, member expressions, array and object
 * expressions, template literals, and binary concatenation. Recursion is
 * bounded by a depth limit to avoid unbounded analysis.
 *
 * @param {object} astNode The AST node to resolve.
 * @param {Map<string, *>} staticValueByName Map of identifier name to known static value.
 * @param {(node: object) => (string|undefined)} getLiteralStringValue Function to extract a literal string from an AST node.
 * @param {(node: object) => (string|undefined)} getMemberExpressionPropertyName Function to extract the property name from a member-expression node.
 * @param {number} [depth=0] Current recursion depth (capped internally).
 * @returns {*} The resolved value, or undefined when it cannot be determined.
 */
export declare const resolveStaticValue: (astNode: object, staticValueByName: Map<string, any>, getLiteralStringValue: (node: object) => (string | undefined), getMemberExpressionPropertyName: (node: object) => (string | undefined), depth?: number) => any;
/**
 * Derive narrowed identifier-to-value bindings from a switch-case node by
 * inspecting the switch discriminant and fall-through case chain.
 *
 * @param {object} switchCaseNode The `SwitchCase` AST node currently in scope.
 * @param {object} switchStatementNode The enclosing `SwitchStatement` AST node.
 * @param {Map<string, *>} staticValueByName Map of identifier name to known static value.
 * @param {(node: object) => (string|undefined)} getLiteralStringValue Function to extract a literal string from an AST node.
 * @param {(node: object) => (string|undefined)} getMemberExpressionPropertyName Function to extract the property name from a member-expression node.
 * @returns {Map<string, *>|undefined} Map of discriminant identifier name to narrowed value, or undefined.
 */
export declare const deriveStaticNarrowingsFromSwitchCase: (switchCaseNode: object, switchStatementNode: object, staticValueByName: Map<string, any>, getLiteralStringValue: (node: object) => (string | undefined), getMemberExpressionPropertyName: (node: object) => (string | undefined)) => Map<string, any> | undefined;
/**
 * Name-to-value lookup that layers the narrowings of one Babel path over the
 * shared map of known static values. Reads fall through to the shared map, so
 * creating a scope costs only its own narrowings rather than a copy of every
 * known value. Offers the `has`/`get`/`set` subset of `Map` that static
 * resolution uses.
 */
declare class ScopedStaticValues {
    staticValueByName: Map<string, any>;
    narrowedValueByName: Map<any, any>;
    /**
     * @param {Map<string, *>} staticValueByName Shared map of identifier name to known static value. Never modified.
     */
    constructor(staticValueByName: Map<string, any>);
    /**
     * @param {string} identifierName Identifier name to look up.
     * @returns {boolean} True when a narrowed or shared value is known.
     */
    has(identifierName: string): boolean;
    /**
     * @param {string} identifierName Identifier name to look up.
     * @returns {*} The narrowed value when one exists, otherwise the shared value.
     */
    get(identifierName: string): any;
    /**
     * @param {string} identifierName Identifier name to narrow.
     * @param {*} value Narrowed value, visible to this scope only.
     * @returns {ScopedStaticValues} This lookup.
     */
    set(identifierName: string, value: any): ScopedStaticValues;
}
/**
 * Build a name-to-value lookup for a Babel path by starting from the provided
 * static values and applying narrowing derived from ancestor if-statements
 * and switch-cases.
 *
 * @param {object} path Babel traversal path whose ancestors are inspected.
 * @param {Map<string, *>} staticValueByName Initial map of identifier name to known static value.
 * @param {(node: object) => (string|undefined)} getLiteralStringValue Function to extract a literal string from an AST node.
 * @param {(node: object) => (string|undefined)} getMemberExpressionPropertyName Function to extract the property name from a member-expression node.
 * @returns {ScopedStaticValues} Scoped name-to-value lookup including ancestor narrowings.
 */
export declare const getScopedStaticValueByName: (path: object, staticValueByName: Map<string, any>, getLiteralStringValue: (node: object) => (string | undefined), getMemberExpressionPropertyName: (node: object) => (string | undefined)) => ScopedStaticValues;
export {};
//# sourceMappingURL=analyzerScope.d.ts.map