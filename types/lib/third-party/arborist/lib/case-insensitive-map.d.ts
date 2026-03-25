export default CIMap;
declare class CIMap extends Map<any, any> {
    constructor(items?: any[]);
    get(key: any): any;
    set(key: any, val: any): this;
    delete(key: any): boolean | undefined;
    has(key: any): boolean;
    #private;
}
//# sourceMappingURL=case-insensitive-map.d.ts.map