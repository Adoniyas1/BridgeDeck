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
    // Windows needs the Common-Controls v6 manifest in every program that uses the dialog plugin
    // (comctl32's TaskDialogIndirect only exists in v6), or it refuses to start it. tauri-build only
    // puts it in the app, so the unit-test program couldn't start; Cargo has no link setting for
    // library tests alone, so the linker embeds this one manifest in the app and the tests alike.
    if std::env::var("TARGET").unwrap_or_default().ends_with("windows-msvc") {
        println!("cargo:rerun-if-changed=windows-manifest.xml");
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build failed");
        return;
    }
    tauri_build::build()
}
