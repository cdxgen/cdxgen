#!/usr/bin/env python3
"""Reconstruct a staged rootfs from a Docker archive for dockertest coverage.

Usage:
  reconstruct-staged-rootfs.py <archive> <extracted_dir> <rootfs_dir>

The script extracts the image archive, replays layer tarballs in manifest order,
applies whiteout markers, and skips paths that cdxgen intentionally excludes
when reconstructing a merged root filesystem for offline/rootfs tests.
"""

import json
import os
import shutil
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

EXTRACT_EXCLUDE_PATHS = (
    "etc/machine-id",
    "etc/gshadow",
    "etc/shadow",
    "etc/passwd",
    "etc/ssl/certs",
    "etc/pki/ca-trust",
    "usr/lib/systemd/",
    "usr/lib64/libdevmapper.so",
    "usr/sbin/",
    "cacerts",
    "ssl/certs",
    "logs/",
    "dev/",
    "proc/",
    "sys/",
    "usr/share/zoneinfo/",
    "usr/share/doc/",
    "usr/share/man/",
    "usr/share/icons/",
    "usr/share/i18n/",
    "var/lib/ca-certificates",
    "root/.gnupg",
    "root/.dotnet",
    "usr/share/licenses/device-mapper-libs",
)
MEDIA_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".tiff",
    ".ico",
    ".svg",
    ".mp3",
    ".wav",
    ".mp4",
    ".avi",
    ".mov",
    ".ttf",
    ".woff",
    ".woff2",
    ".eot",
}
SKIP_TYPES = {
    tarfile.BLKTYPE,
    tarfile.CHRTYPE,
    tarfile.FIFOTYPE,
    tarfile.LNKTYPE,
    tarfile.SYMTYPE,
}


def normalize_name(name):
    if name.startswith("./"):
        name = name[2:]
    path = PurePosixPath(name)
    if path.is_absolute():
        raise ValueError(f"Absolute paths are not allowed: {name}")
    normalized_parts = []
    for part in path.parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError(f"Parent directory segments are not allowed: {name}")
        normalized_parts.append(part)
    if not normalized_parts:
        return ""
    return str(PurePosixPath(*normalized_parts))


def remove_path(path):
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


def copy_regular_file(tar_handle, member, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = tar_handle.extractfile(member)
    if source is None:
        raise ValueError(f"Unable to read archive member contents: {member.name}")
    with source, destination.open("wb") as output_file:
        shutil.copyfileobj(source, output_file)
    os.chmod(destination, stat.S_IMODE(member.mode))


def extract_safe_members(tar_handle, destination_dir):
    for member in tar_handle.getmembers():
        normalized = normalize_name(member.name)
        if not normalized:
            if member.isdir():
                destination_dir.mkdir(parents=True, exist_ok=True)
                continue
            raise ValueError(f"Archive member normalized to empty path: {member.name}")
        destination = destination_dir / normalized
        if member.isdir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        if not member.isreg():
            raise ValueError(
                f"Unsupported archive member type {member.type} for {member.name}. "
                "Only regular files and directories are supported."
            )
        copy_regular_file(tar_handle, member, destination)


def reconstruct_staged_rootfs(archive, extracted_dir, rootfs_dir):
    archive = Path(archive)
    extracted_dir = Path(extracted_dir)
    rootfs_dir = Path(rootfs_dir)
    shutil.rmtree(extracted_dir, ignore_errors=True)
    shutil.rmtree(rootfs_dir, ignore_errors=True)
    extracted_dir.mkdir(parents=True, exist_ok=True)
    rootfs_dir.mkdir(parents=True, exist_ok=True)

    def to_rootfs_path(name):
        normalized = normalize_name(name)
        if not normalized or normalized == ".":
            return rootfs_dir
        return rootfs_dir / normalized

    def apply_whiteout(member_name):
        normalized = normalize_name(member_name)
        if not normalized:
            return False
        basename = PurePosixPath(normalized).name
        if basename == ".wh..wh..opq":
            opaque_dir = to_rootfs_path(str(PurePosixPath(normalized).parent))
            if opaque_dir.is_dir():
                for child in opaque_dir.iterdir():
                    remove_path(child)
            return True
        if basename.startswith(".wh."):
            whiteout_target = PurePosixPath(normalized).parent / basename[4:]
            remove_path(to_rootfs_path(str(whiteout_target)))
            return True
        return False

    def should_skip(member):
        normalized = normalize_name(member.name)
        basename = PurePosixPath(normalized).name
        if basename.startswith(".wh."):
            return True
        if PurePosixPath(normalized).suffix.lower() in MEDIA_EXTENSIONS:
            return True
        if any(excluded in normalized for excluded in EXTRACT_EXCLUDE_PATHS):
            return True
        if member.type in SKIP_TYPES:
            return True
        return not (member.isdir() or member.isreg())

    with tarfile.open(archive) as archive_tar:
        extract_safe_members(archive_tar, extracted_dir)

    manifest = json.loads((extracted_dir / "manifest.json").read_text())
    for layer in manifest[0]["Layers"]:
        normalized_layer = normalize_name(layer)
        if not normalized_layer:
            raise ValueError(f"Layer path normalized to empty: {layer}")
        with tarfile.open(extracted_dir / normalized_layer) as layer_tar:
            members = layer_tar.getmembers()
            for member in members:
                apply_whiteout(member.name)
            for member in members:
                if should_skip(member):
                    continue
                destination = to_rootfs_path(member.name)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                copy_regular_file(layer_tar, member, destination)


if __name__ == "__main__":
    usage = "Usage: reconstruct-staged-rootfs.py <archive> <extracted_dir> <rootfs_dir>"
    if len(sys.argv) == 2 and sys.argv[1] in {"-h", "--help"}:
        print(usage)
        sys.exit(0)
    if len(sys.argv) != 4:
        print(f"Error: expected 3 arguments.\n{usage}", file=sys.stderr)
        sys.exit(1)
    reconstruct_staged_rootfs(sys.argv[1], sys.argv[2], sys.argv[3])
