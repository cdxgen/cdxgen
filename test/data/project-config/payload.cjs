// Stand-in for code a scanned repository would like cdxgen to run. It only
// leaves a marker file next to itself, which the tests look for.
require("node:fs").writeFileSync(
  require("node:path").join(__dirname, "CDXGEN_PROJECT_CONFIG_MARKER"),
  "executed\n",
);
module.exports = {};
