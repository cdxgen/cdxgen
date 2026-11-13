class Model {
  constructor(tableName) {
    this.tableName = tableName;
    this.store = new Map();
  }

  async init() {
    this.store.clear();
  }

  async findByPk(purl) {
    if (this.store.has(purl)) {
      const record = this.store.get(purl);
      let parsedData;

      try {
        parsedData = JSON.parse(record.dataStr);
      } catch (_e) {
        parsedData = record.dataStr;
      }

      return {
        purl: record.purl,
        data: parsedData,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }

    return null;
  }

  async findOrCreate(options) {
    const { where, defaults } = options;
    const existing = await this.findByPk(where.purl);

    if (existing) {
      return [existing, false];
    }

    let dataStr;
    if (typeof defaults.data === "string") {
      dataStr = defaults.data;
    } else {
      dataStr = JSON.stringify(defaults.data);
    }

    const now = new Date().toISOString();
    const searchStr = dataStr.toLowerCase();

    const record = {
      purl: defaults.purl,
      dataStr: dataStr,
      searchStr: searchStr,
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(defaults.purl, record);

    let parsedData;
    try {
      parsedData = JSON.parse(record.dataStr);
    } catch (_e) {
      parsedData = record.dataStr;
    }

    const instance = {
      purl: record.purl,
      data: parsedData,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    return [instance, true];
  }

  async findAll(options) {
    const results = [];
    let searchTerm = null;
    // Honour the sequelize-style attributes option so that lookups that only
    // need the purl do not parse (and retain) a copy of every matching record.
    const wantsData =
      !Array.isArray(options?.attributes) ||
      options.attributes.includes("data");

    if (options?.where?.data?.like) {
      searchTerm = options.where.data.like.replace(/%/g, "").toLowerCase();
    }

    for (const record of this.store.values()) {
      let matches = true;

      if (searchTerm) {
        if (!record.searchStr.includes(searchTerm)) {
          matches = false;
        }
      }

      if (matches) {
        const row = {
          purl: record.purl,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        if (wantsData) {
          try {
            row.data = JSON.parse(record.dataStr);
          } catch (_e) {
            row.data = record.dataStr;
          }
        }
        results.push(row);
      }
    }

    return results;
  }
}

/**
 * Create or load the in-memory Namespaces, Usages, and DataFlows models.
 *
 * Initialises each model and returns a sequelize-like handle along with the
 * model references used by evinse for persisting slice evidence.
 *
 * @returns {Promise<{ sequelize: { close: () => boolean }, Namespaces: Object, Usages: Object, DataFlows: Object }>}
 */
export const createOrLoad = async () => {
  const Namespaces = new Model("Namespaces");
  const Usages = new Model("Usages");
  const DataFlows = new Model("DataFlows");

  await Namespaces.init();
  await Usages.init();
  await DataFlows.init();

  const sequelize = {
    close: () => {
      return true;
    },
  };

  return {
    sequelize,
    Namespaces,
    Usages,
    DataFlows,
  };
};
