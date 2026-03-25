export default Link;
declare class Link extends Node {
    isStoreLink: any;
    set target(target: any);
    get target(): any;
    set resolved(_r: string | null);
    get resolved(): string | null;
    set children(_c: Map<any, any>);
    get children(): Map<any, any>;
    [_loadDeps](): void;
    [_target]: any;
}
import Node from "./node.js";
declare const _loadDeps: unique symbol;
declare const _target: unique symbol;
//# sourceMappingURL=link.d.ts.map