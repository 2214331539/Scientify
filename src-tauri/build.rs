fn main() {
    // Recompile Windows resources when branding changes, even if config is unchanged.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "library_choose",
            "library_command",
            "library_open",
            "library_pdf",
            "library_note",
            "library_external",
            "library_import",
            "library_import_bytes",
            "browser_command",
            "open_project_window",
            "workspace_window_ready",
            "workspace_load",
            "workspace_save",
            "workspace_restore",
            "workspace_migrate_legacy",
            "workspace_import",
            "workspace_export",
            "choose_directory",
            "research_list_files",
            "research_read_file",
            "research_write_file",
            "research_import_pdf",
            "research_read_pdf",
            "research_git_status",
            "research_ask_ai",
            "research_list_models",
            "research_test_model",
            "research_fetch_arxiv",
            "agent_status",
            "agent_handshake",
            "agent_domains",
            "agent_start_thread",
            "agent_start_turn",
            "agent_events",
            "agent_respond",
        ]),
    ))
    .expect("failed to build Tauri manifest");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // The IPC test harness links Tauri's existing resources as well as the app.
        println!(
            "cargo:rustc-link-search=native={}",
            std::env::var("OUT_DIR").unwrap()
        );
    }
}
