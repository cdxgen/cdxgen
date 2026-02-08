export default Inventory;
declare class Inventory {
    get primaryKey(): string;
    get indexes(): string[];
    filter(fn: any): {};
    add(node: any): void;
    delete(node: any): void;
    query(key: any, val: any, ...args: any[]): any;
    has(node: any): boolean;
    set(): void;
    #private;
}
//# sourceMappingURL=inventory.d.ts.map