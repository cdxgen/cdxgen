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
        let parsedData;
        try {
          parsedData = JSON.parse(record.dataStr);
        } catch (_e) {
          parsedData = record.dataStr;
        }

        results.push({
          purl: record.purl,
          data: parsedData,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
    }

    return results;
  }
}

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
