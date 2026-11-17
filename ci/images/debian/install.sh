#! /usr/bin/env bash
set -e

glibc_version=$(ldd --version | head -n1 | awk '{print $NF}')
required_version="2.35"

# Compare versions: if glibc_version < required_version, set the env var
if [ "$(printf '%s\n%s\n' "$glibc_version" "$required_version" | sort -V | head -n1)" != "$required_version" ]; then
  export npm_config_build_from_source=true
fi

if [ x"${ATOM_RUBY_VERSION}" != "x" ]; then
  export RBENV_ROOT=/opt/.rbenv
  git clone https://github.com/rbenv/rbenv.git --depth=1 "$RBENV_ROOT"
  echo "export RBENV_ROOT=${RBENV_ROOT}" >> ~/.bashrc
  echo "export PATH=\"${RBENV_ROOT}/bin:\$PATH\"" >> ~/.bashrc
  echo "eval \"\$(${RBENV_ROOT}/bin/rbenv init - bash)\"" >> ~/.bashrc
  source ~/.bashrc
  mkdir -p "$(rbenv root)/plugins"
  git clone https://github.com/rbenv/ruby-build.git --depth=1 "$(rbenv root)/plugins/ruby-build"
  if [ -n "$RUBY_LANG_URL" ]; then
    sed -i "s|https://cache.ruby-lang.org|$RUBY_LANG_URL|g" $(rbenv root)/plugins/ruby-build/share/ruby-build/*
  fi
  if [ -n "$GITHUB_URL" ]; then
    sed -i "s|https://github.com|$GITHUB_URL|g" $(rbenv root)/plugins/ruby-build/share/ruby-build/*
  fi
  rbenv install $ATOM_RUBY_VERSION -- --disable-install-doc
  if [ -n "$RUBY_LANG_URL" ]; then
    sed -i "s|$RUBY_LANG_URL|https://cache.ruby-lang.org|g" $(rbenv root)/plugins/ruby-build/share/ruby-build/*
  fi
  if [ -n "$GITHUB_URL" ]; then
    sed -i "s|$GITHUB_URL|https://github.com|g" $(rbenv root)/plugins/ruby-build/share/ruby-build/*
  fi
fi

if [ x"${SKIP_ATOM}" != "xyes" ]; then
  ARCH_NAME="$(dpkg --print-architecture)"
  # Download atom native binary
  curl -L $GITHUB_URL/AppThreat/atom/releases/latest/download/atom-${ARCH_NAME} -o /usr/local/bin/atom
  chmod +x /usr/local/bin/atom
  /usr/local/bin/atom --help || true
fi

if [ x"${JAVA_VERSION}" != "x" ]; then
  export SDKMAN_DIR=${SDKMAN_DIR:-/opt/.sdkman}
  curl -L "https://get.sdkman.io" | bash
  SDKMAN_BROKER_API="${SDKMAN_URL}/broker"
  SDKMAN_CANDIDATES_API="${SDKMAN_URL}"
  chmod +x "${SDKMAN_DIR}"/bin/sdkman-init.sh
  source "${SDKMAN_DIR}"/bin/sdkman-init.sh
  printf "sdkman_auto_answer=true\nsdkman_selfupdate_feature=false\nsdkman_auto_env=true\nsdkman_curl_connect_timeout=20\nsdkman_curl_max_time=0" >> "${SDKMAN_DIR}/etc/config"
  sdk install java ${JAVA_VERSION} "${SDKMAN_DIR}/candidates/java"
  if [ x"${MAVEN_VERSION}" != "x" ]; then
    sdk install maven ${MAVEN_VERSION} "${SDKMAN_DIR}/candidates/maven"
  fi
fi

if [ x"${SKIP_PYTHON}" != "xyes" ]; then
  python3 --version
  python3 -m pip install --no-cache-dir --upgrade --ignore-installed pip virtualenv --break-system-packages || true
  python3 -m pip install --no-cache-dir --upgrade pipenv poetry uv --target /opt/pypi
fi

if [ x"${SKIP_NODEJS}" != "xyes" ]; then
  export NVM_DIR=${NVM_DIR:-/opt/.nvm}
  mkdir -p "${NVM_DIR}"
  curl -o- $GITHUB_RAW_URL/nvm-sh/nvm/$NVM_VERSION/install.sh | bash
  chmod +x "${NVM_DIR}/nvm.sh"
  source "${NVM_DIR}/nvm.sh"
  nvm install ${NODE_VERSION}
  npm install --global corepack@latest
fi
