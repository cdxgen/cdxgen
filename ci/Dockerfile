FROM ghcr.io/cyclonedx/cdxgen-ruby-builder:master AS base

ARG SWIFT_SIGNING_KEY=52BB7E3DE28A71BE22EC05FFEF80A866B47A981F
ARG SWIFT_PLATFORM=ubi9
ARG SWIFT_BRANCH=swift-6.2-release
ARG SWIFT_VERSION=swift-6.2-RELEASE
ARG SWIFT_WEBROOT=https://download.swift.org
ARG JAVA_VERSION=24.0.2-tem
ARG SBT_VERSION=1.11.6
# renovate: datasource=maven lookupName=org.apache.maven:maven
ARG MAVEN_VERSION=3.9.11
# renovate: datasource=gradle-version depName=gradle
ARG GRADLE_VERSION=8.14.3
# renovate: datasource=golang-version depName=golang
ARG GO_VERSION=1.25.6
# renovate: datasource=node-version depName=node
ARG NODE_VERSION=24.13.0
ARG RUBY_VERSION=3.4.5
ARG JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8"
ARG SCALA_VERSION=3.7.4

ENV GOPATH=/opt/app-root/go \
    JAVA_VERSION=$JAVA_VERSION \
    SBT_VERSION=$SBT_VERSION \
    MAVEN_VERSION=$MAVEN_VERSION \
    GRADLE_VERSION=$GRADLE_VERSION \
    GRADLE_OPTS="-Dorg.gradle.daemon=false" \
    JAVA_HOME="/opt/.sdkman/candidates/java/${JAVA_VERSION}" \
    MAVEN_HOME="/opt/.sdkman/candidates/maven/${MAVEN_VERSION}" \
    GRADLE_HOME="/opt/.sdkman/candidates/gradle/${GRADLE_VERSION}" \
    SBT_HOME="/opt/.sdkman/candidates/sbt/${SBT_VERSION}" \
    SCALA_VERSION=$SCALA_VERSION \
    SCALA_HOME="/opt/.sdkman/candidates/scala/${SCALA_VERSION}" \
    PYTHON_CMD=/usr/bin/python3 \
    RUBY_VERSION=$RUBY_VERSION \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING="utf-8" \
    COMPOSER_ALLOW_SUPERUSER=1 \
    JAVA_TOOL_OPTIONS=$JAVA_TOOL_OPTIONS \
    SWIFT_SIGNING_KEY=$SWIFT_SIGNING_KEY \
    SWIFT_PLATFORM=$SWIFT_PLATFORM \
    SWIFT_BRANCH=$SWIFT_BRANCH \
    SWIFT_VERSION=$SWIFT_VERSION \
    SWIFT_WEBROOT=$SWIFT_WEBROOT \
    LC_ALL=en_US.UTF-8 \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US.UTF-8 \
    NVM_DIR="/opt/.nvm" \
    TMPDIR=/tmp \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    NODE_COMPILE_CACHE="/opt/cdxgen-node-cache" \
    PYTHONPATH=/opt/pypi \
    CDXGEN_IN_CONTAINER=true \
    CDXGEN_TEMP_DIR=/tmp/cdxgen-temp \
    SDKMAN_DIR=/opt/.sdkman \
    SDKMAN_CANDIDATES_DIR=/opt/.sdkman/candidates \
    RBENV_ROOT=/opt/.rbenv
ENV PATH=${PATH}:/opt/bin:/opt/.nvm/versions/node/v${NODE_VERSION}/bin:${JAVA_HOME}/bin:${MAVEN_HOME}/bin:${GRADLE_HOME}/bin:${SCALA_HOME}/bin:${SBT_HOME}/bin:${GOPATH}/bin:/usr/local/go/bin:/usr/local/bin/:/opt/.local/bin:${PYTHONPATH}/bin:/opt/.rbenv/bin:/opt/.rbenv/versions/3.4.5/bin

RUN set -e; \
    ARCH_NAME="$(rpm --eval '%{_arch}')"; \
    url=; \
    case "${ARCH_NAME##*-}" in \
        'x86_64') \
            OS_ARCH_SUFFIX=''; \
            GOBIN_VERSION='amd64'; \
            ;; \
        'aarch64') \
            OS_ARCH_SUFFIX='-aarch64'; \
            GOBIN_VERSION='arm64'; \
            ;; \
        *) echo >&2 "error: unsupported architecture: '$ARCH_NAME'"; exit 1 ;; \
    esac \
    && microdnf install -y php php-curl php-zip php-bcmath php-json php-pear php-mbstring php-devel make gcc git-core \
        python3 python3-devel python3-pip glibc-common glibc-all-langpacks \
        openssl-devel libffi-devel libyaml zlib-devel \
        pcre2 which tar gzip zip unzip bzip2 sudo ncurses ncurses-devel sqlite-devel gnupg2 dotnet-sdk-10.0 rust cargo \
    && ruby --version \
    && which ruby \
    && /usr/bin/python3 --version \
    && /usr/bin/python3 -m pip install --no-cache-dir --upgrade setuptools==77.0.3 wheel pip virtualenv \
    && /usr/bin/python3 -m pip install --no-cache-dir --upgrade pipenv poetry blint atom-tools uv --target /opt/pypi \
    && ${PYTHONPATH}/bin/poetry --version \
    && ${PYTHONPATH}/bin/pipenv --version \
    && ${PYTHONPATH}/bin/blint --help \
    && mkdir -p /opt/bin /opt/.nvm /tmp/cdxgen-temp \
    && cargo --version \
    && rustc --version \
    && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
    && source ${NVM_DIR}/nvm.sh \
    && nvm install ${NODE_VERSION} \
    && node --version \
    && curl -s "https://get.sdkman.io" | bash \
    && echo -e "sdkman_auto_answer=true\nsdkman_selfupdate_feature=false\nsdkman_auto_env=true\nsdkman_curl_connect_timeout=20\nsdkman_curl_max_time=0" >> /opt/.sdkman/etc/config \
    && source "/opt/.sdkman/bin/sdkman-init.sh" \
    && sdk install java $JAVA_VERSION /opt/.sdkman/candidates/java \
    && sdk install maven $MAVEN_VERSION /opt/.sdkman/candidates/maven \
    && sdk install gradle $GRADLE_VERSION /opt/.sdkman/candidates/gradle \
    && sdk install scala $SCALA_VERSION /opt/.sdkman/candidates/scala \
    && sdk install sbt $SBT_VERSION /opt/.sdkman/candidates/sbt \
    && SWIFT_WEBDIR="$SWIFT_WEBROOT/$SWIFT_BRANCH/$(echo $SWIFT_PLATFORM | tr -d .)$OS_ARCH_SUFFIX" \
    && SWIFT_BIN_URL="$SWIFT_WEBDIR/$SWIFT_VERSION/$SWIFT_VERSION-$SWIFT_PLATFORM$OS_ARCH_SUFFIX.tar.gz" \
    && SWIFT_SIG_URL="$SWIFT_BIN_URL.sig" \
    && export GNUPGHOME="$(mktemp -d)" \
    && curl -fsSL "$SWIFT_BIN_URL" -o swift.tar.gz "$SWIFT_SIG_URL" -o swift.tar.gz.sig \
    && gpg --batch --quiet --keyserver keyserver.ubuntu.com --recv-keys "$SWIFT_SIGNING_KEY" \
    && gpg --batch --verify swift.tar.gz.sig swift.tar.gz \
    && tar -xzf swift.tar.gz --directory / --strip-components=1 \
    && chmod -R o+r /usr/lib/swift \
    && chmod +x /usr/bin/swift \
    && rm -rf "$GNUPGHOME" swift.tar.gz.sig swift.tar.gz \
    && swift --version \
    && curl -LO "https://dl.google.com/go/go${GO_VERSION}.linux-${GOBIN_VERSION}.tar.gz" \
    && tar -C /usr/local -xzf go${GO_VERSION}.linux-${GOBIN_VERSION}.tar.gz \
    && rm go${GO_VERSION}.linux-${GOBIN_VERSION}.tar.gz \
    && go telemetry off \
    && curl -LO "https://raw.githubusercontent.com/technomancy/leiningen/stable/bin/lein" \
    && chmod +x lein \
    && mv lein /usr/local/bin/ \
    && /usr/local/bin/lein \
    && curl -L -O https://github.com/clojure/brew-install/releases/latest/download/linux-install.sh \
    && chmod +x linux-install.sh \
    && ./linux-install.sh && rm linux-install.sh \
    && curl -L --output /usr/local/bin/bazel https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-${GOBIN_VERSION} \
    && chmod +x /usr/local/bin/bazel \
    && useradd -ms /bin/bash cyclonedx \
    && mv /root/.bashrc /home/cyclonedx/.bashrc \
    && chown -R cyclonedx:cyclonedx /home/cyclonedx/.bashrc \
    && npm install --global corepack@latest \
    && npm install -g node-gyp @microsoft/rush --omit=dev \
    && npx node-gyp install \
    && pecl channel-update pecl.php.net \
    && pecl install timezonedb \
    && echo 'extension=timezonedb.so' >> /etc/php.ini \
    && php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');" && php composer-setup.php \
    && mv composer.phar /usr/local/bin/composer \
    && gem install bundler cocoapods \
    && gem --version \
    && bundler --version

FROM base AS cdxgen

LABEL maintainer="cyclonedx" \
      org.opencontainers.image.authors="Prabhu Subramanian <prabhu@appthreat.com>" \
      org.opencontainers.image.source="https://github.com/cdxgen/cdxgen" \
      org.opencontainers.image.url="https://github.com/cdxgen/cdxgen" \
      org.opencontainers.image.version="12.1.x" \
      org.opencontainers.image.vendor="cyclonedx" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="cdxgen" \
      org.opencontainers.image.description="Container image for cdxgen SBOM generator packing latest build tools." \
      org.opencontainers.docker.cmd="docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen -r /app --server"

COPY . /opt/cdxgen

RUN cd /opt/cdxgen && corepack enable pnpm && pnpm config set global-bin-dir /opt/bin \
    && pnpm install:prod && pnpm link && pnpm cache delete \
    && pnpm bin && pnpm bin -g \
    && mkdir -p ${NODE_COMPILE_CACHE} \
    && chown -R cyclonedx:cyclonedx /opt/cdxgen ${NODE_COMPILE_CACHE} ${CDXGEN_TEMP_DIR} \
    && chmod a-w -R /opt \
    && rm -rf /var/cache/yum /root/.cache/pypoetry /root/.cache/node \
    && microdnf clean all
USER cyclonedx
WORKDIR /app
ENTRYPOINT ["cdxgen"]
