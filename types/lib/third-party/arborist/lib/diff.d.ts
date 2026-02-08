export default Diff;
declare class Diff {
    static calculate({ actual, ideal, filterNodes, shrinkwrapInflated, }: {
        actual: any;
        ideal: any;
        filterNodes?: any[];
        shrinkwrapInflated?: any;
    }): any;
    constructor({ actual, ideal, filterSet, shrinkwrapInflated }: {
        actual: any;
        ideal: any;
        filterSet: any;
        shrinkwrapInflated: any;
    });
    filterSet: any;
    shrinkwrapInflated: any;
    children: any[];
    actual: any;
    ideal: any;
    resolved: any;
    integrity: any;
    action: string;
    parent: any;
    leaves: any[];
    unchanged: any[];
    removed: any[];
}
//# sourceMappingURL=diff.d.ts.map