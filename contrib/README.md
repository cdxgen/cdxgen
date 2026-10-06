# Useful scripts

## Validate SBOM using jsonschema

```shell
python bom-validate.py --json ../test/data/vuln-spring-1.5.bom.json
```

## Generate wrapdb releases

```shell
git clone https://github.com/mesonbuild/wrapdb --depth=1
cd wrapdb
python <path to cdxgen>/contrib/wrapdb.py
```

Copy the generated wrapdb-releases.json to the `data` directory.

## Profile aborted requests against the server

Measures what a disconnecting client costs the cdxgen HTTP server, in memory
and in CPU. `--probe-port` preloads `server-mem-probe.mjs` into the server
child so growth can be judged by post-GC heap statistics rather than by RSS,
which overstates it.

```shell
node contrib/server-abort-poc.mjs --requests 500 --no-abort --port 19340 --sample-every 50 --probe-port 19540
```

Abort mid-generation and compare the wasted CPU against a full generation:

```shell
node contrib/server-abort-poc.mjs --mode amplify --requests 20 --port 19341
```

## Record the scalasem reports used by the tests

`test/data/scalasem` holds scalasem reports of compiled Scala projects. To record them again
after a scalasem change, point the script at a directory holding one compiled project per
report name, and at the scalasem to use:

```shell
SCALASEM_CMD=<atom-parsetools checkout>/scalasem.js node contrib/record-scalasem-reports.js <projects dir>
```

Project paths and the cache directories of library jars are replaced, so the recordings do not
depend on the machine.

## Work around a rate-limited Maven Central

When Maven Central answers HTTP 429, a local caching proxy keeps Maven and `cdxgen --deep` sbt
scans working. It serves what the local caches already hold and fetches the rest from a public
mirror. See [maven-proxy/README.md](maven-proxy/README.md).

```shell
contrib/maven-proxy/maven-proxy.sh start
eval "$(contrib/maven-proxy/maven-proxy.sh env)"
```
