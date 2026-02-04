# Introduction

Contents of data directory and their purpose.

| Filename                | Purpose                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| bom-1.4.schema.json     | CycloneDX 1.4 jsonschema for validation                                                                  |
| bom-1.5.schema.json     | CycloneDX 1.5 jsonschema for validation                                                                  |
| cosdb-queries.json      | osquery useful for identifying OS packages for C                                                         |
| cbomosdb-queries.json   | osquery for identifying ssl packages in OS                                                               |
| jsf-0.82.schema.json    | jsonschema for validation                                                                                |
| known-licenses.json     | Hard coded list to correct any license id. Not maintained.                                               |
| lic-mapping.json        | Hard coded list to match a license id based on name                                                      |
| pypi-pkg-aliases.json   | Hard coded list to match a pypi package name from module name                                            |
| python-stdlib.json      | Standard libraries that can be filtered out in python                                                    |
| queries-win.json        | osquery used to generate obom for windows                                                                |
| queries.json            | osquery used to generate obom for linux                                                                  |
| queries-darwin.json     | osquery used to generate obom for darwin                                                                 |
| spdx-licenses.json      | valid spdx id                                                                                            |
| spdx.schema.json        | jsonschema for validation                                                                                |
| vendor-alias.json       | List to correct the group names. Used while parsing .jar files                                           |
| wrapdb-releases.json    | Database of all available meson wraps. Generated using contrib/wrapdb.py.                                |
| frameworks-list.json    | List of string fragments to categorize components into frameworks                                        |
| crypto-oid.json         | Peter Gutmann's crypto oid [mapping](https://www.cs.auckland.ac.nz/~pgut001). GPL, BSD, or CC BY license |
| glibc-stdlib.json       | Standard libraries that can be filtered out in C++                                                       |
| component-tags.json     | List of tags to extract from component description text for easy classification.                         |
| ruby-known-modules.json | Module names for certain known gems. Example: rails                                                      |
