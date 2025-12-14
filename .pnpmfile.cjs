function readPackage(pkg) {
  // pnpm fetched metadata doesn't include libc. So we patch it based on the name to reduce duplicate binaries
  if (pkg.name?.includes("cdxgen-plugins-bin") && pkg.name.includes("linux")) {
    if (pkg.name?.includes("linuxmusl-") && !pkg.libc) {
      pkg.libc = "musl";
    } else if (pkg.name?.includes("linux-") && !pkg.libc) {
      pkg.libc = "glibc";
    }
  } else if (
    pkg.name?.includes("resolver-binding") &&
    pkg.name.includes("linux")
  ) {
    if (pkg.name?.includes("musl") && !pkg.libc) {
      pkg.libc = "musl";
    } else if (pkg.name?.includes("gnu") && !pkg.libc) {
      pkg.libc = "glibc";
    }
  } else if (pkg.name?.includes("@biomejs")) {
    if (pkg.name?.includes("linux") && !pkg.libc) {
      if (pkg.name?.includes("musl")) {
        pkg.libc = "musl";
      } else {
        pkg.libc = "glibc";
      }
    }
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
