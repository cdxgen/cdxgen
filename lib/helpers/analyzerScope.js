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

export const toResolvedValueArray = (value) => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [value];
  }
  return value.flatMap((entry) => toResolvedValueArray(entry));
};

export const resolvedValueKey = (value) => {
  if (value && typeof value === "object") {
    return `object:${JSON.stringify(value)}`;
  }
  return `${typeof value}:${String(value)}`;
};

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

export const filterResolvedValues = (value, predicate) => {
  return mergeResolvedValues(
    ...toResolvedValueArray(value).filter((candidate) => predicate(candidate)),
  );
};

export const hasOnlyResolvedValues = (value, predicate) => {
  const resolvedValues = toResolvedValueArray(value);
  return resolvedValues.length > 0 && resolvedValues.every(predicate);
};

const applyStringTransformToResolvedValue = (value, transform) => {
  const transformedValues = [];
  for (const candidate of toResolvedValueArray(value)) {
    if (typeof candidate !== "string") {
      continue;
    }
    transformedValues.push(transform(candidate));
  }
  return mergeResolvedValues(...transformedValues);
};

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
      }
    }
    return Object.keys(objectValue).length ? objectValue : undefined;
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
      if (
        typeof searchValue !== "string" ||
        typeof replacementValue !== "string"
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

export const getScopedStaticValueByName = (
  path,
  staticValueByName,
  getLiteralStringValue,
  getMemberExpressionPropertyName,
) => {
  const scopedStaticValueByName = new Map(staticValueByName);
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
