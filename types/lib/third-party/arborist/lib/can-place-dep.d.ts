export default CanPlaceDep;
declare class CanPlaceDep {
    static get CONFLICT(): any;
    static get OK(): any;
    static get REPLACE(): any;
    static get KEEP(): any;
    constructor(options: any);
    _treeSnapshot: string;
    canPlace: any;
    canPlaceSelf: any;
    dep: any;
    target: any;
    edge: any;
    explicitRequest: any;
    peerPath: any;
    preferDedupe: any;
    parent: any;
    children: any[];
    isSource: boolean;
    name: any;
    current: any;
    targetEdge: any;
    conflicts: any;
    edgeOverride: boolean;
    checkCanPlace(): any;
    checkCanPlaceCurrent(): any;
    checkCanPlaceNoCurrent(): any;
    get deepestNestingTarget(): any;
    get conflictChildren(): any[];
    get allChildren(): any[];
    get top(): any;
    canPlacePeers(state: any): any;
    _canPlacePeers: any;
    get peerSetSource(): any;
    get peerEntryEdge(): any;
    get description(): any;
}
//# sourceMappingURL=can-place-dep.d.ts.map