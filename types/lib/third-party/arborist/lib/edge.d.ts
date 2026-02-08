export default Edge;
declare class Edge {
    [x: number]: () => ArboristEdge;
    static types: readonly string[];
    static errors: readonly string[];
    constructor(options: any);
    overrides: any;
    peerConflicted: boolean;
    satisfiedBy(node: any): any;
    explain(seen?: any[]): any;
    get bundled(): boolean;
    get workspace(): boolean;
    get prod(): boolean;
    get dev(): boolean;
    get optional(): boolean;
    get peer(): boolean;
    get type(): any;
    get name(): string;
    get rawSpec(): string;
    get spec(): any;
    get accept(): string;
    get valid(): boolean;
    get missing(): boolean;
    get invalid(): boolean;
    get peerLocal(): boolean;
    get error(): any;
    reload(hard?: boolean): void;
    detach(): void;
    get from(): any;
    get to(): any;
    toJSON(): ArboristEdge;
    #private;
}
declare class ArboristEdge {
    constructor(edge: any);
    name: any;
    spec: any;
    type: any;
    from: any;
    to: any;
    error: any;
    peerConflicted: boolean;
    overridden: any;
}
//# sourceMappingURL=edge.d.ts.map