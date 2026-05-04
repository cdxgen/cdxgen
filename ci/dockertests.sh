#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

assert_container_audit_bom() {
  jq -e '[.annotations[]? | select((.text // "") | contains("cdx:audit:category | container-risk |"))] | length > 0' "$1" >/dev/null || {
    echo "Expected container-risk audit findings in $1"
    return 1
  }
  jq -e '[.components[]? | select((.properties // []) | any((.name == "cdx:gtfobins:matched" or .name == "cdx:container:matched") and .value == "true"))] | length > 0' "$1" >/dev/null || {
    echo "Expected GTFOBins or container-risk enrichment properties in $1"
    return 1
  }
}

component_property_signature() {
  jq -S '[
    .components[]? |
    {
      bomRef: ."bom-ref",
      group,
      name,
      purl,
      properties: ((.properties // []) | sort_by(.name, .value)),
      type,
      version
    }
  ] | sort_by(.bomRef, .type, .group, .name, .version, .purl)' "$1"
}

assert_same_component_signature() {
  local expected actual expected_sig actual_sig

  expected="$1"
  actual="$2"
  expected_sig="$(mktemp)"
  actual_sig="$(mktemp)"
  component_property_signature "$expected" >"$expected_sig"
  component_property_signature "$actual" >"$actual_sig"
  if ! diff -u "$expected_sig" "$actual_sig"; then
    echo "Expected matching component/property signature between $expected and $actual"
    rm -f "$expected_sig" "$actual_sig"
    return 1
  fi
  rm -f "$expected_sig" "$actual_sig"
}

container_audit_signature() {
  jq -c '{
    containerRiskAnnotations: [.annotations[]? | select((.text // "") | contains("cdx:audit:category | container-risk |"))] | length,
    enrichedComponents: [.components[]? | select((.properties // []) | any((.name == "cdx:gtfobins:matched" or .name == "cdx:container:matched") and .value == "true"))] | length
  }' "$1"
}

assert_same_container_audit_signature() {
  local expected actual

  expected="$(container_audit_signature "$1")"
  actual="$(container_audit_signature "$2")"
  if [ "$expected" != "$actual" ]; then
    echo "Expected matching container audit signature between $1 and $2"
    echo "expected=$expected"
    echo "actual=$actual"
    return 1
  fi
}

run_docker_tests() {
  trap 'rm -rf /tmp/ubuntu.tar /tmp/ubuntu-archive /tmp/ubuntu-rootfs /tmp/alpine.tar /tmp/alpine-archive /tmp/alpine-rootfs' RETURN

  docker pull ubuntu:latest
  docker save -o /tmp/ubuntu.tar ubuntu:latest
  docker rmi ubuntu:latest
  bin/cdxgen.js /tmp/ubuntu.tar -p -t docker -o bomresults/bom-ubuntu.tar.json --fail-on-error
  bin/cdxgen.js /tmp/ubuntu.tar -p -t docker -o bomresults/bom-ubuntu.tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-ubuntu.tar-audit.json
  python "$SCRIPT_DIR/reconstruct-staged-rootfs.py" /tmp/ubuntu.tar /tmp/ubuntu-archive /tmp/ubuntu-rootfs
  bin/cdxgen.js /tmp/ubuntu-rootfs -p -t rootfs -o bomresults/bom-ubuntu.rootfs.json --fail-on-error
  assert_same_component_signature bomresults/bom-ubuntu.tar.json bomresults/bom-ubuntu.rootfs.json

  docker pull alpine:latest
  docker save -o /tmp/alpine.tar alpine:latest
  docker rmi alpine:latest
  bin/cdxgen.js /tmp/alpine.tar -p -t docker -o bomresults/bom-alpine.tar.json --fail-on-error
  bin/cdxgen.js /tmp/alpine.tar -p -t docker -o bomresults/bom-alpine.tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-alpine.tar-audit.json
  python "$SCRIPT_DIR/reconstruct-staged-rootfs.py" /tmp/alpine.tar /tmp/alpine-archive /tmp/alpine-rootfs
  bin/cdxgen.js /tmp/alpine-rootfs -p -t rootfs -o bomresults/bom-alpine.rootfs.json --fail-on-error
  assert_same_component_signature bomresults/bom-alpine.tar.json bomresults/bom-alpine.rootfs.json
}

run_podman_tests() {
  local podman_service_pid=""

  trap 'rm -f /tmp/docker-alpine.tar /tmp/podman-docker-archive.tar /tmp/podman-oci-archive.tar /tmp/podman-service.log; if [ -n "${podman_service_pid:-}" ]; then kill "$podman_service_pid" 2>/dev/null || true; wait "$podman_service_pid" 2>/dev/null || true; fi' RETURN

  if ! command -v podman >/dev/null 2>&1; then
    echo "Podman is not installed on this runner. Skipping podman coverage."
    return 0
  fi

  docker pull alpine:latest
  bin/cdxgen.js alpine:latest -p -t docker -o bomresults/bom-docker-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-docker-alpine-audit.json
  docker save -o /tmp/docker-alpine.tar alpine:latest
  docker rmi alpine:latest
  bin/cdxgen.js /tmp/docker-alpine.tar -p -t docker -o bomresults/bom-docker-alpine-tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-docker-alpine-tar-audit.json

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  mkdir -p "$XDG_RUNTIME_DIR/podman"
  podman system service -t 0 "unix://$XDG_RUNTIME_DIR/podman/podman.sock" >/tmp/podman-service.log 2>&1 &
  podman_service_pid="$!"
  for _ in $(seq 1 10); do
    if [ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ]; then
      break
    fi
    sleep 1
  done
  if [ ! -S "$XDG_RUNTIME_DIR/podman/podman.sock" ]; then
    echo "Podman socket is unavailable. Skipping podman coverage."
    cat /tmp/podman-service.log || true
    return 0
  fi

  export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
  podman pull docker.io/library/alpine:latest
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-podman-alpine.json --fail-on-error
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-podman-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-alpine-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-audit.json bomresults/bom-podman-alpine-audit.json

  podman save -q --format docker-archive -o /tmp/podman-docker-archive.tar docker.io/library/alpine:latest
  bin/cdxgen.js /tmp/podman-docker-archive.tar -p -t docker -o bomresults/bom-podman-docker-archive.json --fail-on-error
  bin/cdxgen.js /tmp/podman-docker-archive.tar -p -t docker -o bomresults/bom-podman-docker-archive-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-docker-archive-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-tar-audit.json bomresults/bom-podman-docker-archive-audit.json

  podman save -q --format oci-archive -o /tmp/podman-oci-archive.tar docker.io/library/alpine:latest
  podman rmi docker.io/library/alpine:latest
  bin/cdxgen.js /tmp/podman-oci-archive.tar -p -t docker -o bomresults/bom-podman-oci-archive.json --fail-on-error
  bin/cdxgen.js /tmp/podman-oci-archive.tar -p -t docker -o bomresults/bom-podman-oci-archive-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-oci-archive-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-tar-audit.json bomresults/bom-podman-oci-archive-audit.json
}

run_nerdctl_tests() {
  trap 'rm -f /tmp/docker-alpine.tar /tmp/nerdctl-alpine.tar' RETURN

  if ! command -v nerdctl >/dev/null 2>&1; then
    echo "nerdctl is not installed on this runner. Skipping nerdctl coverage."
    return 0
  fi
  if ! nerdctl info >/dev/null 2>&1; then
    echo "nerdctl runtime is unavailable on this runner. Skipping nerdctl coverage."
    return 0
  fi

  docker pull alpine:latest
  bin/cdxgen.js alpine:latest -p -t docker -o bomresults/bom-docker-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-docker-alpine-audit.json
  docker save -o /tmp/docker-alpine.tar alpine:latest
  docker rmi alpine:latest
  bin/cdxgen.js /tmp/docker-alpine.tar -p -t docker -o bomresults/bom-docker-alpine-tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-docker-alpine-tar-audit.json

  export DOCKER_CMD=nerdctl
  nerdctl pull docker.io/library/alpine:latest
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-nerdctl-alpine.json --fail-on-error
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-nerdctl-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-nerdctl-alpine-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-audit.json bomresults/bom-nerdctl-alpine-audit.json

  nerdctl save -o /tmp/nerdctl-alpine.tar docker.io/library/alpine:latest
  nerdctl rmi docker.io/library/alpine:latest
  bin/cdxgen.js /tmp/nerdctl-alpine.tar -p -t docker -o bomresults/bom-nerdctl-alpine-tar.json --fail-on-error
  bin/cdxgen.js /tmp/nerdctl-alpine.tar -p -t docker -o bomresults/bom-nerdctl-alpine-tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-nerdctl-alpine-tar-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-tar-audit.json bomresults/bom-nerdctl-alpine-tar-audit.json
}

main() {
  cd "$REPO_ROOT"
  mkdir -p bomresults

  case "${1:-}" in
    docker)
      run_docker_tests
      ;;
    podman)
      run_podman_tests
      ;;
    nerdctl)
      run_nerdctl_tests
      ;;
    *)
      echo "Usage: $0 <docker|podman|nerdctl>" >&2
      return 1
      ;;
  esac

  ls -ltr bomresults
}

main "$@"
