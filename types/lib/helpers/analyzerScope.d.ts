export function toResolvedValueArray(value: any): any;
export function resolvedValueKey(value: any): string;
export function mergeResolvedValues(...values: any[]): any;
export function filterResolvedValues(value: any, predicate: any): any;
export function hasOnlyResolvedValues(value: any, predicate: any): any;
export function getStaticObjectProperty(objectValue: any, propertyName: any): any;
export function deriveStaticNarrowingsFromCondition(astNode: any, branchTaken: any, getLiteralStringValue: any): any;
export function resolveStaticValue(astNode: any, staticValueByName: any, getLiteralStringValue: any, getMemberExpressionPropertyName: any, depth?: number): any;
export function deriveStaticNarrowingsFromSwitchCase(switchCaseNode: any, switchStatementNode: any, staticValueByName: any, getLiteralStringValue: any, getMemberExpressionPropertyName: any): Map<any, any> | undefined;
export function getScopedStaticValueByName(path: any, staticValueByName: any, getLiteralStringValue: any, getMemberExpressionPropertyName: any): Map<any, any>;
//# sourceMappingURL=analyzerScope.d.ts.map