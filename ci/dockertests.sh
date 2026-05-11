#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly PODMAN_SOCKET_RETRIES=10

source "$SCRIPT_DIR/assertions.sh"
TEST_TMP_DIR=""
PODMAN_SERVICE_PID=""

cleanup_all() {
  if [ -n "$PODMAN_SERVICE_PID" ]; then
    kill "$PODMAN_SERVICE_PID" 2>/dev/null || true
    wait "$PODMAN_SERVICE_PID" 2>/dev/null || true
  fi
  if [ -n "$TEST_TMP_DIR" ]; then
    rm -rf "$TEST_TMP_DIR"
  fi
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
  expected_sig="$(mktemp -p "$TEST_TMP_DIR" expected-sig.XXXXXX)"
  actual_sig="$(mktemp -p "$TEST_TMP_DIR" actual-sig.XXXXXX)"
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

run_cdxgen_image_inventory_tests() {
  local image_ref="${CDXGEN_SELF_TEST_IMAGE:-ghcr.io/cdxgen/cdxgen-python312:latest}"
  local safe_image_name
  local image_bom
  local archive_bom
  local archive_path

  safe_image_name="$(echo "$image_ref" | tr '/:@' '-')"
  image_bom="bomresults/bom-${safe_image_name}.json"
  archive_bom="bomresults/bom-${safe_image_name}-tar.json"
  archive_path="$TEST_TMP_DIR/${safe_image_name}.tar"

  docker pull "$image_ref"
  bin/cdxgen.js "$image_ref" -p -t docker -o "$image_bom" --fail-on-error
  assert_container_file_inventory_bom "$image_bom"
  assert_container_inventory_has_unpackaged_binaries "$image_bom"

  docker save -o "$archive_path" "$image_ref"
  docker rmi "$image_ref"
  bin/cdxgen.js "$archive_path" -p -t docker -o "$archive_bom" --fail-on-error
  assert_container_file_inventory_bom "$archive_bom"
  assert_container_inventory_has_unpackaged_binaries "$archive_bom"
  assert_same_container_file_inventory_signature "$image_bom" "$archive_bom"
}

run_docker_tests() {
  local ubuntu_archive="$TEST_TMP_DIR/ubuntu.tar"
  local ubuntu_extracted_dir="$TEST_TMP_DIR/ubuntu-archive"
  local ubuntu_rootfs_dir="$TEST_TMP_DIR/ubuntu-rootfs"
  local alpine_archive="$TEST_TMP_DIR/alpine.tar"
  local alpine_extracted_dir="$TEST_TMP_DIR/alpine-archive"
  local alpine_rootfs_dir="$TEST_TMP_DIR/alpine-rootfs"

  docker pull ubuntu:latest
  docker save -o "$ubuntu_archive" ubuntu:latest
  docker rmi ubuntu:latest
  bin/cdxgen.js "$ubuntu_archive" -p -t docker -o bomresults/bom-ubuntu.tar.json --fail-on-error
  bin/cdxgen.js "$ubuntu_archive" -p -t docker -o bomresults/bom-ubuntu.tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-ubuntu.tar-audit.json
  assert_container_file_inventory_bom bomresults/bom-ubuntu.tar.json
  assert_trivy_tool_identity_bom bomresults/bom-ubuntu.tar-audit.json
  assert_os_repository_crypto_bom bomresults/bom-ubuntu.tar.json
  python3 "$SCRIPT_DIR/reconstruct-staged-rootfs.py" "$ubuntu_archive" "$ubuntu_extracted_dir" "$ubuntu_rootfs_dir"
  bin/cdxgen.js "$ubuntu_rootfs_dir" -p -t rootfs -o bomresults/bom-ubuntu.rootfs.json --fail-on-error
  assert_container_file_inventory_bom bomresults/bom-ubuntu.rootfs.json
  assert_os_repository_crypto_bom bomresults/bom-ubuntu.rootfs.json
  assert_same_component_signature bomresults/bom-ubuntu.tar.json bomresults/bom-ubuntu.rootfs.json
  assert_same_os_repository_crypto_signature bomresults/bom-ubuntu.tar.json bomresults/bom-ubuntu.rootfs.json

  docker pull alpine:latest
  docker save -o "$alpine_archive" alpine:latest
  docker rmi alpine:latest
  bin/cdxgen.js "$alpine_archive" -p -t docker -o bomresults/bom-alpine.tar.json --fail-on-error
  bin/cdxgen.js "$alpine_archive" -p -t docker -o bomresults/bom-alpine.tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-alpine.tar-audit.json
  assert_container_file_inventory_bom bomresults/bom-alpine.tar.json
  assert_trivy_tool_identity_bom bomresults/bom-alpine.tar-audit.json
  python3 "$SCRIPT_DIR/reconstruct-staged-rootfs.py" "$alpine_archive" "$alpine_extracted_dir" "$alpine_rootfs_dir"
  bin/cdxgen.js "$alpine_rootfs_dir" -p -t rootfs -o bomresults/bom-alpine.rootfs.json --fail-on-error
  assert_container_file_inventory_bom bomresults/bom-alpine.rootfs.json
  assert_same_component_signature bomresults/bom-alpine.tar.json bomresults/bom-alpine.rootfs.json

  run_cdxgen_image_inventory_tests
}

run_podman_tests() {
  local docker_archive="$TEST_TMP_DIR/docker-alpine.tar"
  local docker_archive_audit="bomresults/bom-docker-alpine-tar-audit.json"
  local podman_docker_archive="$TEST_TMP_DIR/podman-docker-archive.tar"
  local podman_oci_archive="$TEST_TMP_DIR/podman-oci-archive.tar"
  local podman_service_log="$TEST_TMP_DIR/podman-service.log"

  if ! command -v podman >/dev/null 2>&1; then
    echo "Podman is not installed on this runner. Skipping podman coverage."
    return 0
  fi

  docker pull alpine:latest
  bin/cdxgen.js alpine:latest -p -t docker -o bomresults/bom-docker-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-docker-alpine-audit.json
  assert_trivy_tool_identity_bom bomresults/bom-docker-alpine-audit.json
  docker save -o "$docker_archive" alpine:latest
  docker rmi alpine:latest
  bin/cdxgen.js "$docker_archive" -p -t docker -o "$docker_archive_audit" --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom "$docker_archive_audit"
  assert_trivy_tool_identity_bom "$docker_archive_audit"
  bin/cdxgen.js "$docker_archive" -p -t docker -o bomresults/bom-docker-alpine-tar.json --fail-on-error
  assert_container_file_inventory_bom bomresults/bom-docker-alpine-tar.json

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  mkdir -p "$XDG_RUNTIME_DIR/podman"
  podman system service -t 0 "unix://$XDG_RUNTIME_DIR/podman/podman.sock" >"$podman_service_log" 2>&1 &
  PODMAN_SERVICE_PID="$!"
  for _ in $(seq 1 "$PODMAN_SOCKET_RETRIES"); do
    if [ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ]; then
      break
    fi
    sleep 1
  done
  if [ ! -S "$XDG_RUNTIME_DIR/podman/podman.sock" ]; then
    echo "Podman socket is unavailable. Skipping podman coverage."
    cat "$podman_service_log" || true
    return 0
  fi

  export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
  podman pull docker.io/library/alpine:latest
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-podman-alpine.json --fail-on-error
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-podman-alpine-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-alpine-audit.json
  assert_same_container_audit_signature bomresults/bom-docker-alpine-audit.json bomresults/bom-podman-alpine-audit.json

  podman save -q --format docker-archive -o "$podman_docker_archive" docker.io/library/alpine:latest
  bin/cdxgen.js "$podman_docker_archive" -p -t docker -o bomresults/bom-podman-docker-archive.json --fail-on-error
  bin/cdxgen.js "$podman_docker_archive" -p -t docker -o bomresults/bom-podman-docker-archive-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-docker-archive-audit.json
  assert_same_container_audit_signature "$docker_archive_audit" bomresults/bom-podman-docker-archive-audit.json

  podman save -q --format oci-archive -o "$podman_oci_archive" docker.io/library/alpine:latest
  podman rmi docker.io/library/alpine:latest
  bin/cdxgen.js "$podman_oci_archive" -p -t docker -o bomresults/bom-podman-oci-archive.json --fail-on-error
  bin/cdxgen.js "$podman_oci_archive" -p -t docker -o bomresults/bom-podman-oci-archive-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_audit_bom bomresults/bom-podman-oci-archive-audit.json
  assert_same_container_audit_signature "$docker_archive_audit" bomresults/bom-podman-oci-archive-audit.json
}

run_nerdctl_tests() {
  local baseline_audit="bomresults/bom-nerdctl-alpine-audit.json"
  local nerdctl_archive="$TEST_TMP_DIR/nerdctl-alpine.tar"

  if ! command -v nerdctl >/dev/null 2>&1; then
    echo "nerdctl is not installed on this runner. Skipping nerdctl coverage."
    return 0
  fi
  if ! nerdctl info >/dev/null 2>&1; then
    echo "nerdctl runtime is unavailable on this runner. Skipping nerdctl coverage."
    return 0
  fi

  export DOCKER_CMD=nerdctl
  nerdctl pull docker.io/library/alpine:latest
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o bomresults/bom-nerdctl-alpine.json --fail-on-error
  bin/cdxgen.js docker.io/library/alpine:latest -p -t docker -o "$baseline_audit" --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_file_inventory_bom bomresults/bom-nerdctl-alpine.json
  assert_container_audit_bom "$baseline_audit"
  assert_trivy_tool_identity_bom "$baseline_audit"

  nerdctl save -o "$nerdctl_archive" docker.io/library/alpine:latest
  nerdctl rmi docker.io/library/alpine:latest
  bin/cdxgen.js "$nerdctl_archive" -p -t docker -o bomresults/bom-nerdctl-alpine-tar.json --fail-on-error
  bin/cdxgen.js "$nerdctl_archive" -p -t docker -o bomresults/bom-nerdctl-alpine-tar-audit.json --bom-audit --bom-audit-categories container-risk --fail-on-error
  assert_container_file_inventory_bom bomresults/bom-nerdctl-alpine-tar.json
  assert_container_audit_bom bomresults/bom-nerdctl-alpine-tar-audit.json
  assert_same_container_audit_signature "$baseline_audit" bomresults/bom-nerdctl-alpine-tar-audit.json
}

main() {
  cd "$REPO_ROOT"
  mkdir -p bomresults
  TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdxgen-dockertests-XXXXXX")"
  export PYTHONDONTWRITEBYTECODE=1
  export PYTHONPYCACHEPREFIX="$TEST_TMP_DIR/pycache"
  trap cleanup_all EXIT

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
