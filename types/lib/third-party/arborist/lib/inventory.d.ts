export default Inventory;
declare class Inventory extends Map<any, any> {
    constructor();
    get primaryKey(): string;
    get indexes(): string[];
    filter(fn: any): Generator<any, void, unknown>;
    add(node: any): void;
    delete(node: any): void;
    query(key: any, val: any, ...args: any[]): any;
    has(node: any): boolean;
    set(): void;
    #private;
}
//# sourceMappingURL=inventory.d.ts.map