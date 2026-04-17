export function createOrLoad(): Promise<{
    sequelize: {
        close: () => boolean;
    };
    Namespaces: Model;
    Usages: Model;
    DataFlows: Model;
}>;
declare class Model {
    constructor(tableName: any);
    tableName: any;
    store: Map<any, any>;
    init(): Promise<void>;
    findByPk(purl: any): Promise<{
        purl: any;
        data: any;
        createdAt: any;
        updatedAt: any;
    } | null>;
    findOrCreate(options: any): Promise<(boolean | {
        purl: any;
        data: any;
        createdAt: any;
        updatedAt: any;
    })[]>;
    findAll(options: any): Promise<{
        purl: any;
        data: any;
        createdAt: any;
        updatedAt: any;
    }[]>;
}
export {};
//# sourceMappingURL=db.d.ts.map