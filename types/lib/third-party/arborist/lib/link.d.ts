export default Link;
declare class Link extends Node {
    [x: number]: () => void;
    isStoreLink: any;
    set target(target: () => void);
    get target(): () => void;
    set resolved(_r: string);
    get resolved(): string;
    set children(_c: any);
    get children(): any;
}
import Node from "./node.js";
//# sourceMappingURL=link.d.ts.map