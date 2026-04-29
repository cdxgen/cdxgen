use std::process::Command;

fn main() {
  let _ = Command::new("echo").arg("hello").status();
  println!("cargo:rustc-link-lib=ssl");
}
