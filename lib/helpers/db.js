import path from "node:path";

import sqlite3 from "@appthreat/sqlite3";

const {
  Database,
  OPEN_READWRITE,
  OPEN_CREATE,
  OPEN_NOMUTEX,
  OPEN_SHAREDCACHE,
} = sqlite3;

/**
 * A lightweight Model wrapper to mimic Sequelize behavior using raw sqlite3
 */
class Model {
  constructor(db, tableName) {
    this.db = db;
    this.tableName = tableName;
  }

  /**
   * Initialize table
   */
  async init() {
    const sql = `CREATE TABLE IF NOT EXISTS ${this.tableName} (
      purl TEXT PRIMARY KEY, 
      data JSON NOT NULL,
      createdAt DATETIME NOT NULL,
      updatedAt DATETIME NOT NULL
    )`;
    return new Promise((resolve, reject) => {
      this.db.run(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * findByPk
   * Returns null if not found, or an object { purl, data (parsed object) }
   */
  async findByPk(purl) {
    const sql = `SELECT * FROM ${this.tableName} WHERE purl = ?`;
    return new Promise((resolve, reject) => {
      this.db.get(sql, [purl], (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          try {
            row.data = JSON.parse(row.data);
          } catch (_e) {
            // ignore
          }
          resolve(row);
        }
      });
    });
  }

  /**
   * findOrCreate
   * @param {Object} options { where: { purl }, defaults: { purl, data } }
   */
  async findOrCreate(options) {
    const { where, defaults } = options;
    const existing = await this.findByPk(where.purl);

    if (existing) {
      return [existing, false];
    }

    const insertSql = `INSERT INTO ${this.tableName} (purl, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)`;
    const dataStr =
      typeof defaults.data === "string"
        ? defaults.data
        : JSON.stringify(defaults.data);
    const now = new Date().toISOString();
    return new Promise((resolve, reject) => {
      this.db.run(insertSql, [defaults.purl, dataStr, now, now], (err) => {
        if (err) reject(err);
        else {
          const instance = {
            purl: defaults.purl,
            data: defaults.data,
            createdAt: now,
            updatedAt: now,
          };
          resolve([instance, true]);
        }
      });
    });
  }

  /**
   * findAll to handle the specific LIKE query from evinser.js
   * @param {Object} options
   */
  async findAll(options) {
    let sql = `SELECT * FROM ${this.tableName}`;
    const params = [];

    if (options?.where?.data) {
      if (options.where.data.like) {
        sql += " WHERE data LIKE ?";
        params.push(options.where.data.like);
      }
    }

    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const results = rows.map((r) => {
            try {
              r.data = JSON.parse(r.data);
            } catch (_e) {
              // ignore
            }
            return r;
          });
          resolve(results);
        }
      });
    });
  }
}

export const createOrLoad = async (dbName, dbPath, logging = false) => {
  const fullPath = dbPath.includes("memory")
    ? dbPath
    : path.join(dbPath, dbName);

  const mode = OPEN_READWRITE | OPEN_CREATE | OPEN_NOMUTEX | OPEN_SHAREDCACHE;

  const db = new Database(fullPath, mode, (err) => {
    if (err && logging) console.error(err.message);
  });

  if (logging) {
    db.on("trace", (sql) => console.log(`[sqlite] ${sql}`));
  }

  const Namespaces = new Model(db, "Namespaces");
  const Usages = new Model(db, "Usages");
  const DataFlows = new Model(db, "DataFlows");

  await Namespaces.init();
  await Usages.init();
  await DataFlows.init();

  return {
    sequelize: db,
    Namespaces,
    Usages,
    DataFlows,
  };
};
