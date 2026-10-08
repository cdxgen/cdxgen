import { assert, it } from "poku";

import { findLicenseId, getLicenses } from "../ecosystems/utils.js";

it("finds license id from name", () => {
  assert.deepStrictEqual(
    findLicenseId("Apache License Version 2.0"),
    "Apache-2.0",
  );
  assert.deepStrictEqual(
    findLicenseId("GNU General Public License (GPL) version 2.0"),
    "GPL-2.0-only",
  );
});

/*
it("get repo license", async () => {
  let license = await getRepoLicense(
    "https://github.com/ShiftLeftSecurity/sast-scan",
    {
      group: "ShiftLeftSecurity",
      name: "sast-scan",
    },
  );
  assert.deepStrictEqual(license, {
    id: "Apache-2.0",
    url: "https://github.com/ShiftLeftSecurity/sast-scan/blob/master/LICENSE",
  });

  license = await getRepoLicense("https://github.com/cdxgen/cdxgen", {
    group: "cyclonedx",
    name: "cdxgen",
  });
  assert.deepStrictEqual(license, {
    id: "Apache-2.0",
    url: "https://github.com/cdxgen/cdxgen/blob/master/LICENSE",
  });

  license = await getRepoLicense("https://cloud.google.com/go", {
    group: "cloud.google.com",
    name: "go"
  });
  assert.deepStrictEqual(license, "Apache-2.0");

  license = await getRepoLicense(undefined, {
    group: "github.com/ugorji",
    name: "go"
  });
  assert.deepStrictEqual(license, {
    id: "MIT",
    url: "https://github.com/ugorji/go/blob/master/LICENSE"
  });
});

it("get go pkg license", async () => {
  let license = await getGoPkgLicense({
    group: "github.com/Azure/azure-amqp-common-go",
    name: "v2",
  });
  assert.deepStrictEqual(license, [
    {
      id: "MIT",
      url: "https://pkg.go.dev/github.com/Azure/azure-amqp-common-go/v2?tab=licenses",
    },
  ]);

  license = await getGoPkgLicense({
    group: "go.opencensus.io",
    name: "go.opencensus.io",
  });
  assert.deepStrictEqual(license, [
    {
      id: "Apache-2.0",
      url: "https://pkg.go.dev/go.opencensus.io?tab=licenses",
    },
  ]);

  license = await getGoPkgLicense({
    group: "github.com/DataDog",
    name: "zstd",
  });
  assert.deepStrictEqual(license, [
    {
      id: "BSD-3-Clause",
      url: "https://pkg.go.dev/github.com/DataDog/zstd?tab=licenses",
    },
  ]);
});
*/

it("get licenses", () => {
  let licenses = getLicenses({ license: "MIT" });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
  ]);

  licenses = getLicenses({ license: ["MIT", "GPL-3.0-or-later"] });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    {
      license: {
        id: "GPL-3.0-or-later",
        url: "https://opensource.org/licenses/GPL-3.0-or-later",
      },
    },
  ]);

  licenses = getLicenses({
    license: {
      id: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
  ]);

  licenses = getLicenses({
    license: [
      {
        type: "MIT",
        url: "https://github.com/harvesthq/chosen/blob/master/LICENSE.md",
      },
    ],
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://github.com/harvesthq/chosen/blob/master/LICENSE.md",
      },
    },
  ]);

  licenses = getLicenses({
    license: "GPL-2.0+",
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "GPL-2.0-or-later",
        url: "https://opensource.org/licenses/GPL-2.0-or-later",
      },
    },
  ]);

  licenses = getLicenses({
    license: "(MIT or Apache-2.0)",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "MIT OR Apache-2.0",
    },
  ]);

  // In case this is not a known license in the current build but it is a valid SPDX license expression
  licenses = getLicenses({
    license: "NOT-GPL-2.1+",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "NOT-GPL-2.1+",
    },
  ]);

  licenses = getLicenses({
    license: "GPL-3.0-only WITH Classpath-exception-2.0",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "GPL-3.0-only WITH Classpath-exception-2.0",
    },
  ]);

  // New cases for license enhancement
  assert.deepStrictEqual(getLicenses({ license: "Apache 2.0" }), [
    {
      license: {
        id: "Apache-2.0",
        url: "https://opensource.org/licenses/Apache-2.0",
      },
    },
  ]);

  assert.deepStrictEqual(getLicenses({ license: "GPL-3.0" }), [
    {
      license: {
        id: "GPL-3.0-only",
        url: "https://opensource.org/licenses/GPL-3.0-only",
      },
    },
  ]);

  assert.deepStrictEqual(getLicenses({ license: "BSD New" }), [
    {
      license: {
        id: "BSD-3-Clause",
        url: "https://opensource.org/licenses/BSD-3-Clause",
      },
    },
  ]);

  licenses = getLicenses({
    license: undefined,
  });
  assert.deepStrictEqual(licenses, undefined);

  // Issue 4466: the legacy npm manifest form `licenses` must resolve when the
  // package object carries it directly (fuzzy 0.1.3 publishes exactly this).
  licenses = getLicenses({
    licenses: [
      {
        type: "MIT",
        url: "https://github.com/mattyork/fuzzy/blob/master/LICENSE-MIT",
      },
    ],
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://github.com/mattyork/fuzzy/blob/master/LICENSE-MIT",
      },
    },
  ]);

  licenses = getLicenses({ licenses: ["MIT", "Apache-2.0"] });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    {
      license: {
        id: "Apache-2.0",
        url: "https://opensource.org/licenses/Apache-2.0",
      },
    },
  ]);

  // CycloneDX-shaped licenses entries are not legacy manifest data and must
  // not be reinterpreted.
  assert.deepStrictEqual(
    getLicenses({ licenses: [{ license: { id: "MIT" } }] }),
    undefined,
  );
});

it("identifies a license by its own title, not the licenses its text quotes", async () => {
  const { guessLicenseId, licenseIdFromText } = await import("./spdx.js");
  const gpl3 = [
    "                    GNU GENERAL PUBLIC LICENSE",
    "                       Version 3, 29 June 2007",
    "",
    " Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>",
    "  ... This General Public License does not permit incorporating your",
    "program into proprietary programs.  ... consider it more useful to permit",
    "linking proprietary applications with the library.  If this is what you",
    "want to do, use the GNU Lesser General Public License instead of this",
    "License.",
  ].join("\n");
  assert.strictEqual(guessLicenseId(gpl3), "GPL-3.0-only");
  const cases = {
    "GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991": "GPL-2.0-only",
    "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999":
      "LGPL-2.1-only",
    "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007":
      "LGPL-3.0-only",
    "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007":
      "AGPL-3.0-only",
    "The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:\n\n Apache License\n Version 2.0, January 2004\n ---- LLVM Exceptions to the Apache 2.0 License ----":
      "Apache-2.0 WITH LLVM-exception",
    "                                 Apache License\n                           Version 2.0, January 2004":
      "Apache-2.0",
    "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge, to any person":
      "MIT",
    "Boost Software License - Version 1.0 - August 17th, 2003": "BSL-1.0",
    "Mozilla Public License Version 2.0\n==================================":
      "MPL-2.0",
    "Copyright (c) 2026 X\n\nRedistribution and use in source and binary forms, with or without modification, are permitted ... Neither the name of the copyright holder nor":
      "BSD-3-Clause",
    "Copyright (c) 2026 X\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided":
      "BSD-2-Clause",
    "This software is provided 'as-is', without any express or implied warranty. ... Permission is granted to anyone to use this software for any purpose":
      "Zlib",
  };
  for (const [text, id] of Object.entries(cases)) {
    assert.strictEqual(licenseIdFromText(text), id, text.slice(0, 40));
  }
  assert.strictEqual(licenseIdFromText("Some custom terms"), undefined);
  assert.strictEqual(licenseIdFromText(""), undefined);
});
