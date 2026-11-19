const getStaticNumberValue = (astNode) => {
  if (!astNode) {
    return undefined;
  }
  if (astNode.type === "NumericLiteral") {
    return astNode.value;
  }
  if (astNode.type === "UnaryExpression" && astNode.operator === "-") {
    const argumentValue = getStaticNumberValue(astNode.argument);
    return typeof argumentValue === "number" ? -argumentValue : undefined;
  }
  return undefined;
};

const getStaticPrimitiveValue = (astNode, getLiteralStringValue) => {
  if (!astNode) {
    return undefined;
  }
  const stringValue = getLiteralStringValue(astNode);
  if (stringValue !== undefined) {
    return stringValue;
  }
  const numberValue = getStaticNumberValue(astNode);
  if (numberValue !== undefined) {
    return numberValue;
  }
  if (astNode.type === "BooleanLiteral") {
    return astNode.value;
  }
  if (astNode.type === "NullLiteral") {
    return null;
  }
  return undefined;
};

/**
 * Flatten a scalar or nested-array value into a single-level array of
 * individual resolved values.
 *
 * @param {*} value Scalar, array, or nested array of values.
 * @returns {Array} Flat array of individual values (empty for undefined).
 */
export const toResolvedValueArray = (value) => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [value];
  }
  return value.flatMap((entry) => toResolvedValueArray(entry));
};

// Resolved objects are deduplicated by content while their property names and
// values add up to at most this many characters, and by identity beyond that.
const MAX_CONTENT_KEY_SIZE = 512;

// Sizes of the objects built by resolveStaticValue(), which are not changed
// afterwards. They share the objects they were built from, so each size is
// recorded once, from the sizes of the members, when the object is built.
const resolvedObjectSizes = new WeakMap();

/**
 * Approximate the serialized size of a resolved value without serializing it.
 *
 * @param {*} value Resolved value to measure.
 * @returns {number} Characters in the property names and values of the value.
 */
const resolvedValueSize = (value) => {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (size, candidate) => size + resolvedValueSize(candidate),
      0,
    );
  }
  if (value && typeof value === "object") {
    return resolvedObjectSizes.get(value) ?? Number.POSITIVE_INFINITY;
  }
  return 1;
};

/**
 * Build a stable dedup key for a resolved value. Primitives and small objects
 * are keyed by a string that is prefixed with the type so that distinct types
 * never collide. Larger objects are their own key, because the size of their
 * serialized form is not bounded by the size of the source.
 *
 * @param {*} value Resolved value to key.
 * @returns {string|object} Stable dedup key (e.g. "string:abc", "object:{...}", or the object itself).
 */
export const resolvedValueKey = (value) => {
  if (value && typeof value === "object") {
    if (resolvedValueSize(value) > MAX_CONTENT_KEY_SIZE) {
      return value;
    }
    return `object:${JSON.stringify(value)}`;
  }
  return `${typeof value}:${String(value)}`;
};

/**
 * Merge one or more scalar/array resolved values into a single deduplicated
 * value, returning a scalar when only one unique value remains.
 *
 * @param {...*} values Resolved values to merge.
 * @returns {*} Merged scalar, deduplicated array, or undefined when empty.
 */
export const mergeResolvedValues = (...values) => {
  const mergedValues = [];
  const seen = new Set();
  for (const value of values) {
    for (const candidate of toResolvedValueArray(value)) {
      const key = resolvedValueKey(candidate);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      mergedValues.push(candidate);
    }
  }
  if (!mergedValues.length) {
    return undefined;
  }
  return mergedValues.length === 1 ? mergedValues[0] : mergedValues;
};

/**
 * Filter the resolved values within a scalar/array by a predicate and re-merge
 * the surviving values.
 *
 * @param {*} value Scalar or array of resolved values.
 * @param {(candidate: *) => boolean} predicate Predicate function to retain values.
 * @returns {*} Re-merged filtered result.
 */
export const filterResolvedValues = (value, predicate) => {
  return mergeResolvedValues(
    ...toResolvedValueArray(value).filter((candidate) => predicate(candidate)),
  );
};

/**
 * Determine whether every resolved value within a scalar/array satisfies the
 * given predicate.
 *
 * @param {*} value Scalar or array of resolved values.
 * @param {(candidate: *) => boolean} predicate Predicate function to test.
 * @returns {boolean} True when there is at least one value and all satisfy the predicate.
 */
export const hasOnlyResolvedValues = (value, predicate) => {
  const resolvedValues = toResolvedValueArray(value);
  return resolvedValues.length > 0 && resolvedValues.every(predicate);
};

// String transforms compute a value from the scanned source instead of copying
// it, and the result of one statement is the input of the next. Chained
// replacements multiply the length of a string, and a different replacement in
// each arm of a conditional doubles the number of candidates. Algorithm names
// are short and few, so anything larger is left unresolved.
const MAX_TRANSFORMED_STRING_LENGTH = 128;
const MAX_TRANSFORMED_VALUE_COUNT = 32;

const applyStringTransformToResolvedValue = (value, transform) => {
  const candidates = toResolvedValueArray(value);
  if (candidates.length > MAX_TRANSFORMED_VALUE_COUNT) {
    return undefined;
  }
  const transformedValues = [];
  for (const candidate of candidates) {
    if (
      typeof candidate !== "string" ||
      candidate.length > MAX_TRANSFORMED_STRING_LENGTH
    ) {
      continue;
    }
    const transformedValue = transform(candidate);
    if (transformedValue.length <= MAX_TRANSFORMED_STRING_LENGTH) {
      transformedValues.push(transformedValue);
    }
  }
  return mergeResolvedValues(...transformedValues);
};

/**
 * Read a named property from a statically-resolved object or array value,
 * mapping across array elements when the value is an array.
 *
 * @param {object|Array} objectValue Resolved object or array value.
 * @param {string} propertyName Property name to read.
 * @returns {*} The property value, a merged array of results, or undefined.
 */
export const getStaticObjectProperty = (objectValue, propertyName) => {
  if (Array.isArray(objectValue)) {
    return mergeResolvedValues(
      ...objectValue.map((entry) =>
        getStaticObjectProperty(entry, propertyName),
      ),
    );
  }
  if (!objectValue || typeof objectValue !== "object") {
    return undefined;
  }
  return objectValue[propertyName];
};

const intersectResolvedValues = (leftValue, rightValue) => {
  const rightValueKeys = new Set(
    toResolvedValueArray(rightValue).map((value) => resolvedValueKey(value)),
  );
  return mergeResolvedValues(
    ...toResolvedValueArray(leftValue).filter((value) =>
      rightValueKeys.has(resolvedValueKey(value)),
    ),
  );
};

const createStaticNarrowingMap = (identifierName, value) => {
  if (!identifierName || value === undefined) {
    return undefined;
  }
  return new Map([[identifierName, value]]);
};

const mergeStaticNarrowingMapsForAnd = (leftMap, rightMap) => {
  if (!leftMap || !rightMap) {
    return undefined;
  }
  const mergedMap = new Map(leftMap);
  for (const [identifierName, value] of rightMap) {
    if (!mergedMap.has(identifierName)) {
      mergedMap.set(identifierName, value);
      continue;
    }
    const intersectedValue = intersectResolvedValues(
      mergedMap.get(identifierName),
      value,
    );
    if (intersectedValue === undefined) {
      return undefined;
    }
    mergedMap.set(identifierName, intersectedValue);
  }
  return mergedMap;
};

const mergeStaticNarrowingMapsForOr = (leftMap, rightMap) => {
  if (!leftMap || !rightMap || leftMap.size !== rightMap.size) {
    return undefined;
  }
  const mergedMap = new Map();
  for (const [identifierName, value] of leftMap) {
    if (!rightMap.has(identifierName)) {
      return undefined;
    }
    mergedMap.set(
      identifierName,
      mergeResolvedValues(value, rightMap.get(identifierName)),
    );
  }
  return mergedMap;
};

const getConditionComparisonIdentifier = (astNode) => {
  return astNode?.type === "Identifier" ? astNode.name : undefined;
};

const getConditionComparisonValue = (astNode, getLiteralStringValue) => {
  return getStaticPrimitiveValue(astNode, getLiteralStringValue);
};

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
export const deriveStaticNarrowingsFromCondition = (
  astNode,
  branchTaken,
  getLiteralStringValue,
) => {
  if (!astNode) {
    return undefined;
  }
  if (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
    ].includes(astNode.type)
  ) {
    return deriveStaticNarrowingsFromCondition(
      astNode.expression,
      branchTaken,
      getLiteralStringValue,
    );
  }
  if (astNode.type === "UnaryExpression" && astNode.operator === "!") {
    return deriveStaticNarrowingsFromCondition(
      astNode.argument,
      !branchTaken,
      getLiteralStringValue,
    );
  }
  if (astNode.type === "LogicalExpression") {
    if (branchTaken && astNode.operator === "&&") {
      return mergeStaticNarrowingMapsForAnd(
        deriveStaticNarrowingsFromCondition(
          astNode.left,
          true,
          getLiteralStringValue,
        ),
        deriveStaticNarrowingsFromCondition(
          astNode.right,
          true,
          getLiteralStringValue,
        ),
      );
    }
    if (branchTaken && astNode.operator === "||") {
      return mergeStaticNarrowingMapsForOr(
        deriveStaticNarrowingsFromCondition(
          astNode.left,
          true,
          getLiteralStringValue,
        ),
        deriveStaticNarrowingsFromCondition(
          astNode.right,
          true,
          getLiteralStringValue,
        ),
      );
    }
    return undefined;
  }
  if (astNode.type !== "BinaryExpression") {
    return undefined;
  }
  const leftIdentifier = getConditionComparisonIdentifier(astNode.left);
  const rightIdentifier = getConditionComparisonIdentifier(astNode.right);
  const leftValue = getConditionComparisonValue(
    astNode.left,
    getLiteralStringValue,
  );
  const rightValue = getConditionComparisonValue(
    astNode.right,
    getLiteralStringValue,
  );
  const identifierName = leftIdentifier || rightIdentifier;
  const comparisonValue = leftIdentifier ? rightValue : leftValue;
  if (!identifierName || comparisonValue === undefined) {
    return undefined;
  }
  if (["===", "=="].includes(astNode.operator) && branchTaken) {
    return createStaticNarrowingMap(identifierName, comparisonValue);
  }
  if (["!==", "!="].includes(astNode.operator) && !branchTaken) {
    return createStaticNarrowingMap(identifierName, comparisonValue);
  }
  return undefined;
};

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
export const resolveStaticValue = (
  astNode,
  staticValueByName,
  getLiteralStringValue,
  getMemberExpressionPropertyName,
  depth = 0,
) => {
  if (!astNode || depth > 6) {
    return undefined;
  }
  const primitiveValue = getStaticPrimitiveValue(
    astNode,
    getLiteralStringValue,
  );
  if (primitiveValue !== undefined) {
    return primitiveValue;
  }
  if (astNode.type === "Identifier") {
    if (staticValueByName.has(astNode.name)) {
      return staticValueByName.get(astNode.name);
    }
    return undefined;
  }
  if (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
    ].includes(astNode.type)
  ) {
    return resolveStaticValue(
      astNode.expression,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
  }
  if (astNode.type === "ConditionalExpression") {
    const testValue = resolveStaticValue(
      astNode.test,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    const consequentValue = resolveStaticValue(
      astNode.consequent,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    const alternateValue = resolveStaticValue(
      astNode.alternate,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    if (typeof testValue === "boolean") {
      return testValue ? consequentValue : alternateValue;
    }
    return mergeResolvedValues(consequentValue, alternateValue);
  }
  if (astNode.type === "LogicalExpression") {
    const leftValue = resolveStaticValue(
      astNode.left,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    const rightValue = resolveStaticValue(
      astNode.right,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    if (astNode.operator === "||") {
      if (leftValue === undefined) {
        return rightValue;
      }
      if (hasOnlyResolvedValues(leftValue, (candidate) => Boolean(candidate))) {
        return leftValue;
      }
      if (hasOnlyResolvedValues(leftValue, (candidate) => !candidate)) {
        return rightValue;
      }
      return mergeResolvedValues(
        filterResolvedValues(leftValue, (candidate) => Boolean(candidate)),
        rightValue,
      );
    }
    if (astNode.operator === "??") {
      if (leftValue === undefined) {
        return rightValue;
      }
      if (
        hasOnlyResolvedValues(
          leftValue,
          (candidate) => candidate !== null && candidate !== undefined,
        )
      ) {
        return leftValue;
      }
      if (
        hasOnlyResolvedValues(
          leftValue,
          (candidate) => candidate === null || candidate === undefined,
        )
      ) {
        return rightValue;
      }
      return mergeResolvedValues(
        filterResolvedValues(
          leftValue,
          (candidate) => candidate !== null && candidate !== undefined,
        ),
        rightValue,
      );
    }
    if (astNode.operator === "&&") {
      if (leftValue === undefined) {
        return undefined;
      }
      if (hasOnlyResolvedValues(leftValue, (candidate) => !candidate)) {
        return leftValue;
      }
      if (hasOnlyResolvedValues(leftValue, (candidate) => Boolean(candidate))) {
        return rightValue;
      }
      return mergeResolvedValues(
        filterResolvedValues(leftValue, (candidate) => !candidate),
        rightValue,
      );
    }
  }
  if (astNode.type === "ObjectExpression") {
    const objectValue = {};
    let objectSize = 0;
    for (const property of astNode.properties || []) {
      if (property.type !== "ObjectProperty") {
        continue;
      }
      const keyName = getMemberExpressionPropertyName(property.key);
      if (!keyName) {
        continue;
      }
      const resolvedValue = resolveStaticValue(
        property.value,
        staticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
        depth + 1,
      );
      if (resolvedValue !== undefined) {
        objectValue[keyName] = resolvedValue;
        objectSize += keyName.length + resolvedValueSize(resolvedValue);
      }
    }
    if (!Object.keys(objectValue).length) {
      return undefined;
    }
    resolvedObjectSizes.set(objectValue, objectSize);
    return objectValue;
  }
  if (
    astNode.type === "MemberExpression" ||
    astNode.type === "OptionalMemberExpression"
  ) {
    const objectValue = resolveStaticValue(
      astNode.object,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    const propertyName = getMemberExpressionPropertyName(astNode.property);
    if (!propertyName) {
      return undefined;
    }
    return getStaticObjectProperty(objectValue, propertyName);
  }
  if (astNode.type === "CallExpression") {
    const callee = astNode.callee;
    if (
      callee?.type !== "MemberExpression" &&
      callee?.type !== "OptionalMemberExpression"
    ) {
      return undefined;
    }
    const methodName = getMemberExpressionPropertyName(callee.property);
    if (!methodName) {
      return undefined;
    }
    const targetValue = resolveStaticValue(
      callee.object,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
      depth + 1,
    );
    if (["toLowerCase", "toUpperCase", "trim"].includes(methodName)) {
      if ((astNode.arguments || []).length) {
        return undefined;
      }
      const transform =
        methodName === "toLowerCase"
          ? (value) => value.toLowerCase()
          : methodName === "toUpperCase"
            ? (value) => value.toUpperCase()
            : (value) => value.trim();
      return applyStringTransformToResolvedValue(targetValue, transform);
    }
    if (["replace", "replaceAll"].includes(methodName)) {
      const searchValue = resolveStaticValue(
        astNode.arguments?.[0],
        staticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
        depth + 1,
      );
      const replacementValue = resolveStaticValue(
        astNode.arguments?.[1],
        staticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
        depth + 1,
      );
      // A long replacement, or one with $ patterns that are expanded again for
      // every match ($` and $' copy the rest of the string each time), is
      // expensive to apply even once.
      if (
        typeof searchValue !== "string" ||
        typeof replacementValue !== "string" ||
        replacementValue.length > MAX_TRANSFORMED_STRING_LENGTH ||
        replacementValue.includes("$")
      ) {
        return undefined;
      }
      return applyStringTransformToResolvedValue(targetValue, (value) =>
        methodName === "replaceAll"
          ? value.replaceAll(searchValue, replacementValue)
          : value.replace(searchValue, replacementValue),
      );
    }
  }
  return undefined;
};

const statementDefinitelyAbrupt = (astNode) => {
  if (!astNode) {
    return false;
  }
  if (
    [
      "BreakStatement",
      "ContinueStatement",
      "ReturnStatement",
      "ThrowStatement",
    ].includes(astNode.type)
  ) {
    return true;
  }
  if (astNode.type === "BlockStatement") {
    return statementListFallsThrough(astNode.body || []) === false;
  }
  if (astNode.type === "IfStatement") {
    return (
      statementDefinitelyAbrupt(astNode.consequent) &&
      statementDefinitelyAbrupt(astNode.alternate)
    );
  }
  return false;
};

const statementListFallsThrough = (statements) => {
  const safeStatements = Array.isArray(statements) ? statements : [];
  if (!safeStatements.length) {
    return true;
  }
  return !statementDefinitelyAbrupt(safeStatements[safeStatements.length - 1]);
};

const getSwitchDiscriminantIdentifier = (astNode) => {
  if (!astNode) {
    return undefined;
  }
  if (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
    ].includes(astNode.type)
  ) {
    return getSwitchDiscriminantIdentifier(astNode.expression);
  }
  return astNode.type === "Identifier" ? astNode.name : undefined;
};

const isStaticPrimitiveResolvedValue = (value) => {
  return (
    ["boolean", "number", "string"].includes(typeof value) || value === null
  );
};

const hasOnlyStaticPrimitiveResolvedValues = (value) => {
  return hasOnlyResolvedValues(value, isStaticPrimitiveResolvedValue);
};

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
export const deriveStaticNarrowingsFromSwitchCase = (
  switchCaseNode,
  switchStatementNode,
  staticValueByName,
  getLiteralStringValue,
  getMemberExpressionPropertyName,
) => {
  if (!switchCaseNode || !switchStatementNode) {
    return undefined;
  }
  const identifierName = getSwitchDiscriminantIdentifier(
    switchStatementNode.discriminant,
  );
  if (!identifierName) {
    return undefined;
  }
  const switchCases = switchStatementNode.cases || [];
  const currentCaseIndex = switchCases.indexOf(switchCaseNode);
  if (currentCaseIndex === -1) {
    return undefined;
  }
  if (switchCaseNode.test === null) {
    const knownDiscriminantValue = staticValueByName.get(identifierName);
    if (!hasOnlyStaticPrimitiveResolvedValues(knownDiscriminantValue)) {
      return undefined;
    }
    const explicitCaseValues = [];
    for (const caseNode of switchCases) {
      if (caseNode.test === null) {
        continue;
      }
      const caseValue = resolveStaticValue(
        caseNode.test,
        staticValueByName,
        getLiteralStringValue,
        getMemberExpressionPropertyName,
      );
      if (!hasOnlyStaticPrimitiveResolvedValues(caseValue)) {
        return undefined;
      }
      explicitCaseValues.push(...toResolvedValueArray(caseValue));
    }
    const explicitCaseKeys = new Set(
      explicitCaseValues.map((value) => resolvedValueKey(value)),
    );
    const remainingValues = toResolvedValueArray(knownDiscriminantValue).filter(
      (value) => !explicitCaseKeys.has(resolvedValueKey(value)),
    );
    const narrowedValue = mergeResolvedValues(...remainingValues);
    return createStaticNarrowingMap(identifierName, narrowedValue);
  }
  let chainStartIndex = currentCaseIndex;
  for (
    let caseIndex = currentCaseIndex - 1;
    caseIndex >= 0 &&
    statementListFallsThrough(switchCases[caseIndex].consequent);
    caseIndex -= 1
  ) {
    chainStartIndex = caseIndex;
  }
  const caseValues = [];
  for (
    let caseIndex = chainStartIndex;
    caseIndex <= currentCaseIndex;
    caseIndex += 1
  ) {
    const caseNode = switchCases[caseIndex];
    if (caseNode.test === null) {
      return undefined;
    }
    const caseValue = resolveStaticValue(
      caseNode.test,
      staticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
    );
    if (!hasOnlyStaticPrimitiveResolvedValues(caseValue)) {
      return undefined;
    }
    caseValues.push(caseValue);
  }
  const narrowedValue = mergeResolvedValues(...caseValues);
  return createStaticNarrowingMap(identifierName, narrowedValue);
};

/**
 * Name-to-value lookup that layers the narrowings of one Babel path over the
 * shared map of known static values. Reads fall through to the shared map, so
 * creating a scope costs only its own narrowings rather than a copy of every
 * known value. Offers the `has`/`get`/`set` subset of `Map` that static
 * resolution uses.
 */
class ScopedStaticValues {
  /**
   * @param {Map<string, *>} staticValueByName Shared map of identifier name to known static value. Never modified.
   */
  constructor(staticValueByName) {
    this.staticValueByName = staticValueByName;
    this.narrowedValueByName = new Map();
  }

  /**
   * @param {string} identifierName Identifier name to look up.
   * @returns {boolean} True when a narrowed or shared value is known.
   */
  has(identifierName) {
    return (
      this.narrowedValueByName.has(identifierName) ||
      this.staticValueByName.has(identifierName)
    );
  }

  /**
   * @param {string} identifierName Identifier name to look up.
   * @returns {*} The narrowed value when one exists, otherwise the shared value.
   */
  get(identifierName) {
    return this.narrowedValueByName.has(identifierName)
      ? this.narrowedValueByName.get(identifierName)
      : this.staticValueByName.get(identifierName);
  }

  /**
   * @param {string} identifierName Identifier name to narrow.
   * @param {*} value Narrowed value, visible to this scope only.
   * @returns {ScopedStaticValues} This lookup.
   */
  set(identifierName, value) {
    this.narrowedValueByName.set(identifierName, value);
    return this;
  }
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
export const getScopedStaticValueByName = (
  path,
  staticValueByName,
  getLiteralStringValue,
  getMemberExpressionPropertyName,
) => {
  const scopedStaticValueByName = new ScopedStaticValues(staticValueByName);
  const ancestorNarrowingContexts = [];
  let currentPath = path;
  while (currentPath?.parentPath) {
    const parentPath = currentPath.parentPath;
    if (parentPath.node?.type === "IfStatement") {
      const branchTaken =
        currentPath.key === "consequent"
          ? true
          : currentPath.key === "alternate"
            ? false
            : undefined;
      if (branchTaken !== undefined) {
        ancestorNarrowingContexts.push({
          branchTaken,
          test: parentPath.node.test,
          type: "if",
        });
      }
    }
    if (
      parentPath.node?.type === "SwitchCase" &&
      parentPath.parentPath?.node?.type === "SwitchStatement"
    ) {
      ancestorNarrowingContexts.push({
        switchCaseNode: parentPath.node,
        switchStatementNode: parentPath.parentPath.node,
        type: "switch-case",
      });
    }
    currentPath = parentPath;
  }
  ancestorNarrowingContexts.reverse().forEach((context) => {
    const narrowedValues =
      context.type === "if"
        ? deriveStaticNarrowingsFromCondition(
            context.test,
            context.branchTaken,
            getLiteralStringValue,
          )
        : deriveStaticNarrowingsFromSwitchCase(
            context.switchCaseNode,
            context.switchStatementNode,
            scopedStaticValueByName,
            getLiteralStringValue,
            getMemberExpressionPropertyName,
          );
    if (!narrowedValues?.size) {
      return;
    }
    narrowedValues.forEach((value, identifierName) => {
      scopedStaticValueByName.set(identifierName, value);
    });
  });
  return scopedStaticValueByName;
};
