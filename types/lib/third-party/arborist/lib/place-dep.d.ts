export default PlaceDep;
declare class PlaceDep {
    constructor(options: any);
    auditReport: any;
    dep: any;
    edge: any;
    explicitRequest: any;
    force: any;
    installLinks: any;
    installStrategy: any;
    legacyPeerDeps: any;
    parent: any;
    preferDedupe: any;
    strictPeerDeps: any;
    updateNames: any;
    canPlace: any;
    canPlaceSelf: any;
    checks: any;
    children: PlaceDep[];
    needEvaluation: any;
    peerConflict: any;
    placed: any;
    target: any;
    current: any;
    name: any;
    top: any;
    oldDep: any;
    replaceOldDep(): void;
    pruneForReplacement(node: any, oldDeps: any): void;
    pruneDedupable(node: any, descend?: boolean): void;
    get isMine(): boolean;
    warnPeerConflict(edge: any, dep: any): void;
    failPeerConflict(edge: any, dep: any): void;
    explainPeerConflict(edge: any, dep: any): {
        code: string;
        edge: any;
        dep: any;
        force: any;
        isMine: boolean;
        strictPeerDeps: any;
    };
    getStartNode(): any;
    get allChildren(): any[];
}
//# sourceMappingURL=place-dep.d.ts.map