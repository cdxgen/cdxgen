# Build environment for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this file with the repository as the build context, then analyses the finished
# image with no network, so everything cdxgen and its tests need is fetched here.
# Node.js matches .nvmrc.
FROM node:26.12.1-trixie@sha256:97fa0f1b59035c6072721a88d55be1371c7cb1cc942b521e1cc5c72ec87655f4

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 python3-pip python3-venv unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Node.js 25 and later ship without corepack. pnpm is installed the way https://get.pnpm.io installs
# pnpm 12, without piping a script into a shell: the native binary comes from the
# @pnpm/exe.linux-<arch> package and the dist/ tree it expects beside it from the pnpm package, and
# `pnpm pm setup` puts both under PNPM_HOME. Neither tarball is unpacked until it matches a sha512
# committed to this repository. packageManager in package.json pins the pnpm tarball, and the first
# document of pnpm-lock.yaml pins every @pnpm/exe platform package of that release. Setup runs
# outside /src so the project's pnpm settings do not apply to it, and it leaves shell config alone
# because the ENV lines below put pnpm on PATH.
ENV CI=true \
    PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}/bin:${PATH}"
RUN set -eu; \
    spec="$(node -p 'require("./package.json").packageManager')"; \
    case "$spec" in \
      pnpm@*+sha512.*) ;; \
      *) echo "packageManager must pin pnpm with a sha512 digest, found: $spec" >&2; exit 1 ;; \
    esac; \
    version="${spec#pnpm@}"; \
    version="${version%%+*}"; \
    case "$(uname -m)" in \
      x86_64) arch=x64 ;; \
      aarch64) arch=arm64 ;; \
      *) echo "pnpm publishes no Linux glibc binary for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    resolution="$(awk -v key="  '@pnpm/exe.linux-${arch}@${version}':" '$0 == key { getline; print; exit }' pnpm-lock.yaml)"; \
    exe_integrity="${resolution#*integrity: sha512-}"; \
    exe_integrity="${exe_integrity%%\}*}"; \
    exe_integrity="${exe_integrity%%,*}"; \
    if [ -z "$resolution" ] || [ "$exe_integrity" = "$resolution" ]; then \
      echo "pnpm-lock.yaml pins no sha512 for @pnpm/exe.linux-${arch}@${version}" >&2; exit 1; \
    fi; \
    tmp="$(mktemp -d)"; \
    registry=https://registry.npmjs.org; \
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp/pnpm.tgz" \
      "$registry/pnpm/-/pnpm-${version}.tgz"; \
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp/exe.tgz" \
      "$registry/@pnpm/exe.linux-${arch}/-/exe.linux-${arch}-${version}.tgz"; \
    { \
      echo "${spec##*+sha512.}  $tmp/pnpm.tgz"; \
      echo "$(printf '%s' "$exe_integrity" | base64 -d | od -An -v -tx1 | tr -d ' \n')  $tmp/exe.tgz"; \
    } | sha512sum -c -; \
    mkdir "$tmp/pnpm" "$tmp/exe" "$tmp/setup"; \
    tar -xzf "$tmp/pnpm.tgz" -C "$tmp/pnpm"; \
    tar -xzf "$tmp/exe.tgz" -C "$tmp/exe"; \
    mv "$tmp/exe/package/pnpm" "$tmp/setup/pnpm"; \
    mv "$tmp/pnpm/package/dist" "$tmp/setup/dist"; \
    (cd "$tmp" && ./setup/pnpm pm setup --force --no-modify-path); \
    rm -rf "$tmp"; \
    pnpm --version

# Same install as CI (.github/workflows/nodejs.yml). The optional dependencies stay: the server
# middleware, the plugins-bin helpers used for container and rootfs scans, and safer-exec for tracebom.
RUN pnpm run install:frozen

# Put the package's commands (cdxgen, cdx-verify, cdxi, ...) on PATH, as a global install would.
RUN node -e 'const fs = require("node:fs"); const path = require("node:path"); \
      const { bin } = JSON.parse(fs.readFileSync("package.json", "utf8")); \
      for (const [name, file] of Object.entries(bin)) fs.symlinkSync(path.resolve(file), `/usr/local/bin/${name}`);' \
    && cdxgen --version

# Run the unit tests while the network is up, so a broken image shows in the build log. Failures are
# reported, not fatal.
RUN pnpm test || echo "WARNING: pnpm test reported failures"
