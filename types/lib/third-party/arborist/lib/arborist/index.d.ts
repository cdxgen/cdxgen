export default Arborist;
declare const Arborist_base: any;
declare class Arborist extends Arborist_base {
    [x: number]: (node: any) => Promise<any>;
    [x: string]: any;
    constructor(options?: {});
    options: {
        Arborist: Function;
        binLinks: boolean;
        cache: any;
        dryRun: boolean;
        formatPackageLock: boolean;
        force: boolean;
        global: boolean;
        ignoreScripts: boolean;
        installStrategy: any;
        lockfileVersion: any;
        packageLockOnly: boolean;
        path: any;
        rebuildBundle: boolean;
        replaceRegistryHost: any;
        savePrefix: unknown;
        scriptShell: any;
        workspaces: any;
        workspacesEnabled: boolean;
        nodeVersion: any;
    };
    replaceRegistryHost: any;
    cache: any;
    diff: any;
    path: any;
    workspaceNodes(tree: any, workspaces: any): any[];
    workspaceDependencySet(tree: any, workspaces: any, includeWorkspaceRoot: any): any;
    excludeWorkspacesDependencySet(tree: any): any;
    dedupe(options?: {}): Promise<any>;
}
//# sourceMappingURL=index.d.ts.map