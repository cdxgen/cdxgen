export default YarnLock;
declare class YarnLock {
    static parse(data: any): YarnLock;
    static fromTree(tree: any): YarnLock;
    static get Entry(): typeof YarnLockEntry;
    entries: any;
    endCurrent(): void;
    current: YarnLockEntry;
    subkey: any;
    parse(data: any): this;
    splitQuoted(str: any, delim: any): any[];
    toString(): string;
    fromTree(tree: any): this;
    addEntryFromNode(node: any): void;
    entryDataFromNode(node: any): {
        dependencies: any;
        optionalDependencies: any;
        version: any;
        resolved: any;
        integrity: any;
    };
}
declare class YarnLockEntry {
    constructor(specs: any);
    resolved: any;
    version: any;
    integrity: any;
    dependencies: any;
    optionalDependencies: any;
    toString(): string;
    addSpec(spec: any): void;
    #private;
}
//# sourceMappingURL=yarn-lock.d.ts.map