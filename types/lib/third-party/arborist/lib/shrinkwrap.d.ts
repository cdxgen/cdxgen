export default Shrinkwrap;
declare class Shrinkwrap {
    static get defaultLockfileVersion(): number;
    static load(options: any): Promise<Shrinkwrap>;
    static get keyOrder(): string[];
    static reset(options: any): Promise<Shrinkwrap>;
    static metaFromNode(node: any, path: any, options?: {}): {
        name: any;
        devDependencies: any;
        resolved: any;
        extraneous: boolean;
        peer: boolean;
        dev: boolean;
        optional: boolean;
        devOptional: boolean;
    } | {
        resolved: any;
        link: boolean;
    };
    constructor(options?: {});
    lockfileVersion: any;
    tree: any;
    path: any;
    filename: any;
    data: any;
    indent: any;
    newline: any;
    loadedFromDisk: boolean;
    type: any;
    yarnLock: YarnLock;
    hiddenLockfile: any;
    loadingError: any;
    resolveOptions: any;
    shrinkwrapOnly: any;
    checkYarnLock(spec: any, options?: {}): any;
    reset(): void;
    originalLockfileVersion: any;
    get loadFiles(): any;
    get resetFiles(): any;
    inferFormattingOptions(packageJSONData: any): void;
    load(): Promise<this>;
    ancientLockfile: boolean;
    delete(nodePath: any): void;
    get(nodePath: any): any;
    add(node: any): void;
    addEdge(edge: any): void;
    commit(): any;
    toJSON(): any;
    toString(options?: {}): any;
    save(options?: {}): any;
    #private;
}
import YarnLock from "./yarn-lock.js";
//# sourceMappingURL=shrinkwrap.d.ts.map