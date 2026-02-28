import { assert, it } from "poku";

import { checkLicenses } from "../../bin/licenses.js";

it("checks dependency licenses", async () => {
  assert.equal(
    checkLicenses(),
    0,
    "There shouldn't have been license discrepancies",
  );
});
