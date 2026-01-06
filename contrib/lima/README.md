# Introduction

[Lima](https://lima-vm.io/) launches Linux virtual machines with automatic file sharing and port forwarding (similar to WSL2).

## Getting Started

Use the below command to install lima and create a cdxgen vm.

```shell
brew install lima
```

on Linux

Install qemu, qemu-img, qemu-x86 packages.

```shell
curl -LO https://github.com/lima-vm/lima/releases/download/v0.22.0/lima-0.22.0-Linux-x86_64.tar.gz
sudo tar -C /usr/local -xf lima-0.22.0-Linux-x86_64.tar.gz
```

```shell
git clone https://github.com/cdxgen/cdxgen.git
cd cdxgen

# The below command might take several minutes

limactl start --name=cdxgen contrib/lima/cdxgen-opensuse.yaml --tty=false
```

For ubuntu, use the below command.

```shell
limactl start --name=cdxgen contrib/lima/cdxgen-ubuntu.yaml --tty=false
```

Settings used for a recent Mac.

```shell
limactl start --name=cdxgen-ubuntu contrib/lima/cdxgen-ubuntu.yaml --tty=false --cpus 10 --disk 320 --memory 32 --vm-type vz --rosetta --mount-type virtiofs
```

Sample output

```shell
❯ limactl start --name=cdxgen contrib/lima/cdxgen-opensuse.yaml --tty=false
INFO[0000] Terminal is not available, proceeding without opening an editor
INFO[0000] Starting the instance "cdxgen" with VM driver "qemu"
INFO[0000] QEMU binary "/usr/local/bin/qemu-system-x86_64" seems properly signed with the "com.apple.security.hypervisor" entitlement
INFO[0000] Attempting to download the image              arch=x86_64 digest= location="https://download.opensuse.org/distribution/leap/15.6/appliances/openSUSE-Leap-15.6-Minimal-VM.x86_64-Cloud.qcow2"
INFO[0000] Using cache "/Users/user/Library/Caches/lima/download/by-url-sha256/df847b33b9afd652992e2d5ad084eaf97a93ee54f6957c288a643f3c11fdde1c/data"
INFO[0000] Attempting to download the nerdctl archive    arch=x86_64 digest="sha256:2c841e097fcfb5a1760bd354b3778cb695b44cd01f9f271c17507dc4a0b25606" location="https://github.com/containerd/nerdctl/releases/download/v1.7.6/nerdctl-full-1.7.6-linux-amd64.tar.gz"
INFO[0000] Using cache "/Users/user/Library/Caches/lima/download/by-url-sha256/b86908f1f5ea2af45aec405f0fd389eba1999b51e3972ca78215ace94d2da2a6/data"
INFO[0001] [hostagent] hostagent socket created at /Users/user/.lima/cdxgen/ha.sock
INFO[0001] [hostagent] Using system firmware ("/usr/local/share/qemu/edk2-x86_64-code.fd")
INFO[0001] [hostagent] Starting QEMU (hint: to watch the boot progress, see "/Users/user/.lima/cdxgen/serial*.log")
INFO[0002] SSH Local Port: 61020
INFO[0001] [hostagent] Waiting for the essential requirement 1 of 4: "ssh"
```

Pass `--arch=aarch64` to create an arm64 version. You may need this [bios](https://gitlab.com/kraxel/qemu/-/blob/master/pc-bios/edk2-aarch64-code.fd.bz2?ref_type=heads) file under `$HOME/.local/share/qemu/` directory.

```shell
# Takes a lot more time
limactl start --name=cdxgen-aarch64 --arch=aarch64 contrib/lima/cdxgen-opensuse.yaml --tty=false
```

To open a shell to the cdxgen VM:

```shell
limactl shell cdxgen
```

To stop the VM:

```shell
limactl stop cdxgen
```

## Usage

Create a command alias to use the VM version of cdxgen.

```shell
alias cdxgen="limactl shell cdxgen cdxgen"
```

## Troubleshooting

Monitor the installation by tailing the `/var/log/cloud-init-output.log` file.

```shell
limactl shell cdxgen sudo tail -f /var/log/cloud-init-output.log
```

```shell
limactl shell cdxgen-ubuntu sudo tail -f /var/log/cloud-init-output.log
```
