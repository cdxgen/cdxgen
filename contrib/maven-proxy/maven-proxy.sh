#!/usr/bin/env bash
# Start, stop or check the local Maven Central stand-in. See README.md.
#
#   contrib/maven-proxy/maven-proxy.sh start | stop | status | env
#
# `env` prints the exports that route Maven, and sbt on a Coursier cache of its own, through
# the proxy: eval "$(contrib/maven-proxy/maven-proxy.sh env)"
set -u
here=$(cd "$(dirname "$0")" && pwd)
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  cache_home=$XDG_CACHE_HOME
elif [ "$(uname)" = "Darwin" ]; then
  cache_home=$HOME/Library/Caches
else
  cache_home=$HOME/.cache
fi
state=${MAVEN_PROXY_STATE:-$cache_home/cdxgen-maven-proxy}
port=${MAVEN_PROXY_PORT:-18081}
base=http://127.0.0.1:$port
mkdir -p "$state"

running() {
  curl -sf "$base/health" >/dev/null 2>&1
}

write_config() {
  printf 'central.from=https://repo1.maven.org/maven2\ncentral.to=%s/maven2\n' "$base" \
    > "$state/mirror.properties"
  # The mirror keeps the id "central", so the _remote.repositories files Maven writes into
  # ~/.m2 stay valid after the proxy is gone.
  cat > "$state/settings.xml" <<XML
<settings>
  <mirrors>
    <mirror>
      <id>central</id>
      <mirrorOf>central</mirrorOf>
      <url>$base/maven2</url>
    </mirror>
  </mirrors>
</settings>
XML
}

case ${1:-status} in
  start)
    write_config
    if running; then
      echo "already running on $port"
      exit 0
    fi
    MAVEN_PROXY_STATE=$state MAVEN_PROXY_PORT=$port \
      nohup node "$here/maven-proxy.mjs" >> "$state/proxy.log" 2>&1 &
    echo $! > "$state/proxy.pid"
    for _ in $(seq 1 50); do
      if running; then
        echo "started pid $(cat "$state/proxy.pid") on $port, state in $state"
        exit 0
      fi
      sleep 0.1
    done
    echo "did not start, see $state/proxy.log"
    exit 1
    ;;
  stop)
    if [ -f "$state/proxy.pid" ] && kill "$(cat "$state/proxy.pid")" 2>/dev/null; then
      echo stopped
    fi
    rm -f "$state/proxy.pid" "$state/mirror.properties" "$state/settings.xml"
    ;;
  status)
    curl -sf "$base/health" && echo || { echo "not running"; exit 1; }
    ;;
  env)
    if ! running || [ ! -f "$state/settings.xml" ]; then
      echo "echo 'maven-proxy is not running' >&2"
      exit 1
    fi
    echo "export MAVEN_PROXY_STATE='$state'"
    echo "export PATH='$here/bin':\"\$PATH\""
    # mvn splits MAVEN_ARGS on spaces, so the path is not quoted.
    echo "export MAVEN_ARGS=\"\${MAVEN_ARGS:+\$MAVEN_ARGS }-s $state/settings.xml\""
    ;;
  *)
    echo "usage: $0 start|stop|status|env" >&2
    exit 2
    ;;
esac
