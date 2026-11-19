#!/usr/bin/env bash
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


#
# The GitHub provided machines typically have the following disk allocation:
# Total space: 72GB
# Allocated: 48 GB
# Free: 25 GB
# This script frees up 16 GB of disk space by deleting unneeded packages and
# large directories.
#
echo "=============================================================================="
echo "Freeing up disk space on CI system"
echo "=============================================================================="

echo "Listing 100 largest packages"
dpkg-query -Wf '${Installed-Size}\t${Package}\n' | sort -nr | head -n 100
df -h
echo "Removing large packages"
sudo apt-get remove --purge -y '^azure-.*'
sudo apt-get remove --purge -y '^dotnet-.*'
sudo apt-get remove --purge -y '^google-cloud-.*'
sudo apt-get remove --purge -y '^libllvm.*'
sudo apt-get remove --purge -y '^linux-.*-headers-.*'
sudo apt-get remove --purge -y '^llvm-.*'
sudo apt-get remove --purge -y '^microsoft-.*'
sudo apt-get remove --purge -y '^mongodb-.*'
sudo apt-get remove --purge -y '^mysql-.*'
sudo apt-get remove --purge -y '^openjdk.*' 'temurin-.*'
sudo apt-get remove --purge -y '^php.*'
sudo apt-get remove --purge -y '^postgresql.*'
sudo apt-get remove --purge -y firefox
sudo apt-get remove --purge -y google-chrome-stable
sudo apt-get remove --purge -y hhvm
sudo apt-get remove --purge -y libgl1-mesa-dri
sudo apt-get remove --purge -y mono-devel
sudo apt-get remove --purge -y powershell
sudo apt-get remove --purge -y snapd
sudo apt-get autoremove -y
sudo apt-get clean
dpkg-query -Wf '${Installed-Size}\t${Package}\n' | sort -nr | head -n 100
df -h
echo "Removing large directories"

sudo rm -rf /usr/share/dotnet/
sudo rm -rf /usr/local/graalvm/
sudo rm -rf /usr/local/.ghcup/
sudo rm -rf /usr/local/share/powershell
sudo rm -rf /usr/local/share/chromium
# Remove the hosted tool cache and the Android SDK for the space they hold.
# A job may already have installed tools into the tool cache with
# setup-java, setup-sbt, setup-node and similar actions before this script
# runs, so every tool directory named by an environment variable or a PATH
# entry is kept.
if [ -d /opt/hostedtoolcache ]; then
  tools_in_use=$(env | tr ':=' '\n\n' | grep '^/opt/hostedtoolcache/' | cut -d/ -f4 | sort -u || true)
  for tool_dir in /opt/hostedtoolcache/*/; do
    tool_name=$(basename "$tool_dir")
    if printf '%s\n' "$tools_in_use" | grep -qxF "$tool_name"; then
      echo "Keeping $tool_dir, which this job uses"
      continue
    fi
    sudo rm -rf "$tool_dir"
  done
fi
sudo rm -rf /usr/local/lib/android/
df -h
