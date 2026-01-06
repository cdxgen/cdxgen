# Mixed Python/JavaScript Project Example (Jupyter Notebook case)

This contrib example demonstrates how `cdxgen` handles mixed-language projects.
It reproduces the bug reported in [#2236](https://github.com/cdxgen/cdxgen/issues/2236),
where the root `pyproject.toml` caused a crash due to a missing `SrcFile` property.

## File Structure That Triggers the Bug

jupyter-notebook/
├── pyproject.toml                           # ← Root file (caused crash)
├── package.json                             # Node.js dependencies
├── node_modules/
│   └── node-gyp/
│       └── gyp/
│           └── pyproject.toml
└── ...

## How to Reproduce

### Quick Setup
```
chmod +x setup.sh
./setup.sh
```


## Manual Steps

`git clone --branch v7.4.5 --depth 1 https://github.com/jupyter/notebook.git`
`cd notebook`
`npm install node-gyp --no-audit --no-fund --legacy-peer-deps`
`cdxgen -r . --type python --output bom.json --no-install-deps`

## Expected Behavior
Before fix → TypeError: Cannot read properties of undefined (reading 'startsWith')

After fix → SBOM successfully generated (bom.json)
