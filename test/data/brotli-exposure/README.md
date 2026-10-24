# Brotli exposure fixtures

Small, hand-made trees for the CVE-2026-111497 (Brotli decoder) coverage:

- `uv-extras`: a uv.lock where Brotli arrives only through extras. `urllib3`
  has no required dependencies, only the `brotli` extra, and `brotlicffi` is
  gated to non-CPython interpreters by its marker.
- `vcpkg-cmake`, `vcpkg-only`: a vcpkg manifest that pins brotli through
  `overrides`, with and without a CMake project next to it.
- `meson-wrap`: a meson project whose WrapDB wrap pins google-brotli 1.1.0.
- `vendored`, `vendored-fixed`: Brotli sources copied into `third_party/`, at
  1.2.0 without the fix and at 1.2.1 with it. Only the files the version and
  fix readers look at are kept, with the upstream text of those lines. The
  nested `go/MODULE.bazel` takes brotli from the parent directory through a
  `local_path_override`, as upstream's does.
- `dotnet`: the `Microsoft.NETCore.App.deps.json` of the .NET 8.0.32
  runtime for linux-arm64, cut down to the runtime pack and three of its files.
