#### About
This documentation is intended for use with PRs in which the snapshot tests have failed. In such a case, updates may 
need to be made to the snapshots. It is **VERY IMPORTANT** that contributors keep in mind that improvements and 
regressions may _both_ be present. Invalid/undesirable changes can easily be obscured by improvements. 

For this reason, it is preferable for each change to be copy/pasted individually if there are a small number. If it is a 
large number - like if every single component is affected - it is imperative that the contributor reviews the changes 
before doing a bulk copy/paste. The html reports or the json diff can be used for this purpose.

#### Procedure for local testing
1. Download the [snapshot BOMs](https://github.com/AppThreat/cdxgen-samples/archive/refs/heads/main.zip). 
2. Download the zip of cdxgen boms generated for your PR from the [Test BOM Snapshots workflow](https://github.com/cdxgen/cdxgen/actions/workflows/snapshot-tests.yml).
3. Extract zips into separate directories.
4. Create a python 3.10+ virtual environment.
5. Install custom-json-diff `pip install -r requirements.txt`
6. Run diff_tests.py specifying the paths to the extracted snapshot directories.
   `diff_tests.py -d path/to/snapshots/from/step/1 path/to/snapshots/from/step/2`

#### Notes on custom-json-diff usage
The snapshot tests utilize the following settings:
- Allows newer versions in the newly-generated snapshot versus the original from the cdxgen-samples repo.
- Allows new data in components that is not present in the original (e.g. additional properties)
- Everything is sorted.
- Local testing must still use boms generated in CI NOT locally - download these from the artifact produced for your branch in the [Test BOM Snapshots workflow](https://github.com/cdxgen/cdxgen/actions/workflows/snapshot-tests.yml)
- Includes component properties, licenses, and evidence
- Excludes:
  - components.externalReferences
  - components.hashes
  - metadata.timestamp
  - metadata.tools.components.bom-ref
  - metadata.tools.components.purl
  - metadata.tools.components.version
  - serialNumber

The equivalent direct usage of custom-json-diff to compare only one snapshot
`cjd -i bom1.json bom2.json -o diffs.json bom-diff --include-extra properties,licenses,evidence -anv -and`

#### Example Usage
```bash
curl https://github.com/AppThreat/cdxgen-samples/archive/refs/heads/main.zip -o original_snapshots.zip
unzip original_snapshots.zip
unzip cdxgen_boms.zip -d new_snapshots # downloaded workflow artifact from github
python3 -m venv .venv
source .venv/bin/activate
pip3 install custom-json-diff
python3 test/diff/diff_tests.py -d original_snapshots new_snapshots
```
