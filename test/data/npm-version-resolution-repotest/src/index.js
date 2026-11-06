const debug = require("debug");
const ms = require("ms");

const log = debug("resolution");

module.exports = () => {
  log("waiting");
  return ms("2 days");
};
