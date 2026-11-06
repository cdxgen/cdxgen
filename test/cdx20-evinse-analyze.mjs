// Run prepareDB and analyzeProject over the evinse inputs named on the
// command line (`<project dir> <input>[::model]...`) and print, per input,
// how many components the evinse loader read and how many purls
// analyzeProject located, as a `RESULT {...}` line. `::model` hands the
// loaded model over in memory, as cdxgen does. Spawned as a script file
// rather than with `-e`: Deno runs `-e` code as a classic script, where
// import statements are a syntax error.
import process from "node:process";

import {
  analyzeProject,
  loadEvinseInputBom,
  prepareDB,
} from "../lib/evinser/evinser.js";

const [projectDir, ...inputs] = process.argv.slice(2);
const out = {};
for (const spec of inputs) {
  const [input, mode] = spec.split("::");
  const options = {
    _: [projectDir],
    input,
    output: `${input}.out`,
    language: "js",
  };
  if (mode === "model") {
    options.inputBomJson = loadEvinseInputBom({ input }).bomJson;
  }
  const dbObjMap = await prepareDB(options);
  const artefacts = await analyzeProject(dbObjMap, options);
  out[spec] = {
    components: loadEvinseInputBom(options).bomJson.components?.length ?? 0,
    purlLocations: Object.keys(artefacts.purlLocationMap || {}).length,
  };
}
process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
