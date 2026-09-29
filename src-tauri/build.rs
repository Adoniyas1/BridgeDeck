fn main() {
    // Build timestamp, compared against source mtimes to tell when synced edits need a rebuild.
    // The rerun-if-changed list keeps it fresh whenever any of the watched sources change.
    let built_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    println!("cargo:rustc-env=BRIDGEDECK_BUILT_MS={built_ms}");
    for path in ["src", "Cargo.toml", "tauri.conf.json", "../src", "../index.html", "../package.json"] {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
