#! /bin/sh
# Install dosai for the .NET images; the images point DOSAI_CMD at it.
#
# The dosai in cdxgen-plugins-bin is framework-dependent and, from dosai
# 5.0.0, needs a .NET 11 runtime. Images with an older SDK install the
# self-contained -full build, which carries its own runtime. The .NET 11
# images install the framework-dependent .NET tool from NuGet instead, which
# runs on the image's own runtime.
#
# Usage: install-dosai.sh [full|tool]   (default full)
#
# Environment variables honoured:
#   DOSAI_VERSION - dosai release (default 5.0.0)
#   DOSAI_SHA256  - sha256 of the -full binary, for a DOSAI_VERSION other
#                   than the default
#   GITHUB_URL    - GitHub mirror (default https://github.com)
#   NUGET_REPO    - NuGet mirror for the tool install
#   DOSAI_PREFIX  - install directory (default /opt/dosai)

set -e

DEFAULT_DOSAI_VERSION="5.0.0"
DOSAI_VERSION="${DOSAI_VERSION:-${DEFAULT_DOSAI_VERSION}}"
GITHUB_URL="${GITHUB_URL:-https://github.com}"
DOSAI_PREFIX="${DOSAI_PREFIX:-/opt/dosai}"
mode="${1:-full}"

case "${mode}" in
  tool)
    # Pinned to the exact version so image builds stay reproducible
    if [ -n "${NUGET_REPO}" ]; then
      dotnet tool install Dosai --version "${DOSAI_VERSION}" --tool-path "${DOSAI_PREFIX}" \
        --add-source "${NUGET_REPO}/index.json" --ignore-failed-sources
    else
      dotnet tool install Dosai --version "${DOSAI_VERSION}" --tool-path "${DOSAI_PREFIX}"
    fi
    ;;
  full)
    if ls /lib/ld-musl-* > /dev/null 2>&1; then
      libc=musl
    else
      libc=glibc
    fi
    # The hashes are the release asset digests of the default version
    case "${libc}-$(uname -m)" in
      glibc-x86_64)
        asset=Dosai-linux-amd64-full
        default_sha256=75934ea2837df0715c47f04333ae736092da9f7d2cf76ed284f45bbb92d5777b
        ;;
      glibc-aarch64)
        asset=Dosai-linux-arm64-full
        default_sha256=41845c9ce7ec80b34c8b7eac387dfed48f0b546c4fe7559b3fd4b15a20398132
        ;;
      musl-x86_64)
        asset=Dosai-linux-musl-x64-full
        default_sha256=d60b74deb9120907113736891d5e5bea9ebe87a8b9a1aafca68bd8ef7ba6d7e8
        ;;
      musl-aarch64)
        asset=Dosai-linux-musl-arm64-full
        default_sha256=fe4c0b3c3f1fa271fe797217722830fdb952d6ca7deba9575b302ccd0d8fbbe3
        ;;
      *)
        echo "install-dosai: unsupported platform ${libc}-$(uname -m)" >&2
        exit 1
        ;;
    esac
    if [ -z "${DOSAI_SHA256}" ]; then
      if [ "${DOSAI_VERSION}" != "${DEFAULT_DOSAI_VERSION}" ]; then
        echo "install-dosai: set DOSAI_SHA256 for dosai ${DOSAI_VERSION}" >&2
        exit 1
      fi
      DOSAI_SHA256="${default_sha256}"
    fi
    mkdir -p "${DOSAI_PREFIX}"
    curl -fsSL -o "${DOSAI_PREFIX}/dosai" \
      "${GITHUB_URL}/owasp-dep-scan/dosai/releases/download/v${DOSAI_VERSION}/${asset}"
    echo "${DOSAI_SHA256}  ${DOSAI_PREFIX}/dosai" | sha256sum -c -
    chmod 0755 "${DOSAI_PREFIX}/dosai"
    ;;
  *)
    echo "install-dosai: unknown mode ${mode}; use full or tool" >&2
    exit 1
    ;;
esac

"${DOSAI_PREFIX}/dosai" --version
