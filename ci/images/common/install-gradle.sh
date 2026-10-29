#!/bin/sh
# Install a Gradle distribution from services.gradle.org, verified against the
# sha256 checksum Gradle publishes next to it.
#
# The sdkman broker does not serve Gradle 9.7.1 and later, and distro packages
# lag behind (Alpine ships Gradle 8, which cannot run on Java 27), so images
# that need a current Gradle 9 install it with this script.
#
# Usage: install-gradle.sh <version> <install-dir>
#   <install-dir> must not exist yet; the distribution's top-level directory is
#   moved there, so <install-dir>/bin/gradle is the launcher.
#
# Environment:
#   GRADLE_DIST_URL - distribution base URL (default
#                     https://services.gradle.org/distributions), for mirrors

set -eu

version="${1:-}"
dest="${2:-}"
if [ -z "$version" ] || [ -z "$dest" ]; then
  echo "usage: install-gradle.sh <version> <install-dir>" >&2
  exit 2
fi
case "$version" in
  *[!0-9A-Za-z.-]*)
    echo "install-gradle.sh: unexpected Gradle version '$version'" >&2
    exit 2
    ;;
esac
if [ -e "$dest" ]; then
  echo "install-gradle.sh: $dest already exists" >&2
  exit 2
fi

base="${GRADLE_DIST_URL:-https://services.gradle.org/distributions}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/gradle.zip" "$base/gradle-$version-bin.zip"
expected="$(curl -fsSL --retry 3 "$base/gradle-$version-bin.zip.sha256" | tr -d '[:space:]')"
case "$expected" in
  *[!0-9a-f]*|"")
    echo "install-gradle.sh: no usable sha256 for gradle-$version-bin.zip" >&2
    exit 1
    ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "install-gradle.sh: no usable sha256 for gradle-$version-bin.zip" >&2
  exit 1
fi
echo "$expected  $work/gradle.zip" | sha256sum -c -

unzip -q "$work/gradle.zip" -d "$work/dist"
mkdir -p "$(dirname "$dest")"
mv "$work/dist/gradle-$version" "$dest"
