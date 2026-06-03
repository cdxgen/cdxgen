use sha2::{Sha256, Digest};

fn main() {
    let data = b"cdxgen rust dataflow repotest";

    // rusi will detect this cryptographic operation and emit cdx:rusi:crypto:* properties
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hasher.finalize();

    println!("SHA-256: {:x}", hash);
}