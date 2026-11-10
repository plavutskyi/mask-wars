// What decides an answer, as one sha256 the module can state about itself: its sources, its manifest, its dependency
// lock, its toolchain and the two shared lists it carries. The build hands it to the code as MASKWARS_CHECK_RULES
// (lib.rs: `RULES`), and every signed message carries it, so a signature names the rules that made it.
//
// The hash is over each file's name, its length and its bytes, in a fixed order. The same checkout gives the same
// hash on any machine: the files are checked out with the same line endings everywhere (.gitattributes).
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo names the crate's folder"));
    let lists = here.join("../../packages/check");
    let mut files: Vec<(String, PathBuf)> = ["Cargo.toml", "Cargo.lock", "build.rs", "manifest.json", "rust-toolchain.toml"]
        .iter()
        .map(|name| (name.to_string(), here.join(name)))
        .collect();
    let mut sources: Vec<String> = fs::read_dir(here.join("src"))
        .expect("src")
        .map(|entry| entry.expect("a file of src").file_name().into_string().expect("a name in UTF-8"))
        .filter(|name| name.ends_with(".rs"))
        .collect();
    sources.sort();
    files.extend(sources.into_iter().map(|name| (format!("src/{name}"), here.join("src").join(&name))));
    files.extend(["list.json", "list.mainnet.json"].iter().map(|name| (format!("lists/{name}"), lists.join(name))));

    let mut hash = Sha256::new();
    for (name, path) in &files {
        let bytes = read(path);
        hash.update(format!("{name}\n{}\n", bytes.len()).as_bytes());
        hash.update(&bytes);
        println!("cargo:rerun-if-changed={}", path.display());
    }
    // A file added to src is a change too.
    println!("cargo:rerun-if-changed={}", here.join("src").display());
    let hex: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    println!("cargo:rustc-env=MASKWARS_CHECK_RULES={hex}");
}

fn read(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
