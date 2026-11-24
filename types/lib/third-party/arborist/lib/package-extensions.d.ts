declare const EXTENSION_FIELDS: string[];
declare const parseSelector: (key: any) => {
    name: string;
    range: string | null;
};
declare const rangeMatches: (range: any, version: any) => any;
declare const canonicalStringify: (val: any) => any;
declare const canonicalHash: (packageExtensions: any) => string;
declare class PackageExtensions {
    raw: any;
    present: boolean;
    selectors: {
        key: string;
        name: string;
        range: string | null;
        ext: any;
    }[];
    hash: string | null;
    constructor(raw: any);
    wouldMatch(name: any, version: any): boolean;
    match(name: any, version: any): {
        key: string;
        name: string;
        range: string | null;
        ext: any;
    };
    apply(pkg: any): {
        pkg: any;
        applied: {
            selector: any;
        };
    } | null;
}
export default PackageExtensions;
export { canonicalHash, canonicalStringify, EXTENSION_FIELDS, PackageExtensions, parseSelector, rangeMatches, };
//# sourceMappingURL=package-extensions.d.ts.map