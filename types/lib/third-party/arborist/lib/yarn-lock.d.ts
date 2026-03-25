export default YarnLock;
declare class YarnLock {
    static parse(data: any): YarnLock;
    static fromTree(tree: any): YarnLock;
    static get Entry(): typeof YarnLockEntry;
    entries: Map<any, any> | null;
    endCurrent(): void;
    current: YarnLockEntry | null | undefined;
    subkey: string | typeof nullSymbol | undefined;
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
declare const nullSymbol: unique symbol;
//# sourceMappingURL=yarn-lock.d.ts.map