import { readFileSync } from "node:fs";

import { getNpmMetadata, shouldFetchLicense } from "./utils.js";

export async function parseCaxaMetadata(mfile) {
  let mdata;
  try {
    mdata = JSON.parse(readFileSync(mfile));
  } catch (_e) {
    return {};
  }
  if (!mdata || !mdata.components) {
    return {};
  }
  const { parentComponent } = mdata;
  if (parentComponent) {
    parentComponent.properties = parentComponent.properties || [];
    parentComponent.properties.push({
      name: "internal:is_executable",
      value: "true",
    });
  }
  for (const comp of mdata.components) {
    comp.scope = "required";
    comp.properties = comp.properties || [];
    if (comp.purl.startsWith("pkg:generic/node@")) {
      comp.properties.push({
        name: "internal:is_executable",
        value: "true",
      });
    }
    comp.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "binary-analysis",
            confidence: 1,
            value: parentComponent.name,
          },
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: mfile,
          },
        ],
      },
    };
  }
  if (shouldFetchLicense()) {
    mdata.components = await getNpmMetadata(mdata.components);
  }
  return mdata;
}
