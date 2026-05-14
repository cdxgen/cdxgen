#!/bin/sh
set -eu

version="${1:?Usage: setup-upx.sh <version> <archive-name> <sha256> [install-dir]>}"
archive_name="${2:?Usage: setup-upx.sh <version> <archive-name> <sha256> [install-dir]>}"
expected_sha256="${3:?Usage: setup-upx.sh <version> <archive-name> <sha256> [install-dir]>}"
install_dir="${4:-/usr/local/bin}"

tmp_dir="$(mktemp -d)"
archive_path="$tmp_dir/$archive_name"
extract_dir="$tmp_dir/extract"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

mkdir -p "$extract_dir" "$install_dir"
download_url="https://github.com/upx/upx/releases/download/v$version/$archive_name"

echo "Downloading $download_url"
curl -fsSL --retry 3 --retry-delay 2 -o "$archive_path" "$download_url"

if command -v sha256sum >/dev/null 2>&1; then
  echo "$expected_sha256  $archive_path" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "SHA-256 mismatch for $archive_name: expected $expected_sha256, got $actual_sha256" >&2
    exit 1
  fi
else
  echo "Neither sha256sum nor shasum is available for hash verification" >&2
  exit 1
fi

tar -xf "$archive_path" -C "$extract_dir"
upx_binary="$(find "$extract_dir" -type f -name upx | head -n 1)"

if [ -z "$upx_binary" ]; then
  echo "Unable to find the UPX binary in $archive_name" >&2
  exit 1
fi

cp "$upx_binary" "$install_dir/upx"
chmod 0755 "$install_dir/upx"
"$install_dir/upx" --version
