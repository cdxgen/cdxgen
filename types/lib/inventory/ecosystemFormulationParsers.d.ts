export declare const MAX_READ_BYTES: number;
export declare const MAX_ASSETS_READ_BYTES: number;
/**
 * Parser for make and CMake build inputs (C/C++ and friends).
 *
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export declare const makefileFormulationParser: {
    id: string;
    patterns: string[];
    parse(files: string[]): {
        components: Object[];
    };
};
/**
 * Parser for go.mod build inputs. The compiled binaries are read by the
 * binary/OBOM path through the bounded Go buildinfo reader, not here.
 *
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export declare const goModuleFormulationParser: {
    id: string;
    patterns: string[];
    parse(files: string[]): {
        components: Object[];
    };
};
/**
 * Parser for pip requirements and constraints files.
 *
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export declare const pythonRequirementsFormulationParser: {
    id: string;
    patterns: string[];
    parse(files: string[]): {
        components: Object[];
    };
};
/**
 * Parser for .NET build inputs: project.assets.json (the file `dotnet
 * restore` writes; some projects call it packages.assets.json) and the
 * SDK-style .csproj project files.
 *
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export declare const dotnetProjectFormulationParser: {
    id: string;
    patterns: string[];
    parse(files: string[]): {
        components: Object[];
    };
};
//# sourceMappingURL=ecosystemFormulationParsers.d.ts.map