export default OverrideSet;
declare class OverrideSet {
    static findSpecificOverrideSet(first: any, second: any): any;
    static doOverrideSetsConflict(first: any, second: any): boolean;
    constructor({ overrides, key, parent }: {
        overrides: any;
        key: any;
        parent: any;
    });
    parent: any;
    children: Map<any, any>;
    name: any;
    key: any;
    keySpec: any;
    value: any;
    childrenAreEqual(other: any): boolean;
    isEqual(other: any): any;
    getEdgeRule(edge: any): any;
    getNodeRule(node: any): any;
    getMatchingRule(node: any): any;
    ancestry(): Generator<this, void, unknown>;
    get isRoot(): boolean;
    get ruleset(): Map<any, any>;
}
//# sourceMappingURL=override-set.d.ts.map