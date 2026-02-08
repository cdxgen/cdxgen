export function createOrLoad(dbName: any, dbPath: any, logging?: boolean): Promise<{
    sequelize: any;
    Namespaces: Model;
    Usages: Model;
    DataFlows: Model;
}>;
/**
 * A lightweight Model wrapper to mimic Sequelize behavior using raw sqlite3
 */
declare class Model {
    constructor(db: any, tableName: any);
    db: any;
    tableName: any;
    /**
     * Initialize table
     */
    init(): Promise<any>;
    /**
     * findByPk
     * Returns null if not found, or an object { purl, data (parsed object) }
     */
    findByPk(purl: any): Promise<any>;
    /**
     * findOrCreate
     * @param {Object} options { where: { purl }, defaults: { purl, data } }
     */
    findOrCreate(options: any): Promise<any>;
    /**
     * findAll to handle the specific LIKE query from evinser.js
     * @param {Object} options
     */
    findAll(options: any): Promise<any>;
}
export {};
//# sourceMappingURL=db.d.ts.map