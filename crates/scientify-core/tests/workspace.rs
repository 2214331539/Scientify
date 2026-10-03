use scientify_core::{
    storage::{read_workspace, Storage},
    workspace::{empty, parse, validate},
};
use serde_json::{json, Value};
use std::fs;
use tempfile::tempdir;

fn fixture() -> Value {
    let mut data = empty();
    data["projects"] = json!([{"id":"p1","name":"泛化研究","question":"为什么？","createdAt":"2026-09-23","extra":{"preserve":true}}]);
    data["records"] = json!([{"id":"r1","project":"p1","title":"实验设计","body":"重要研究内容","type":"实验设计","status":"待验证","createdAt":"2026-09-23","updatedAt":"2026-09-23"}]);
    data["futureExtension"] = json!({"keep":[1,2,3]});
    data
}

#[test]
fn personal_inbox_only_accepts_notes_and_conversations() {
    let mut data = fixture();
    data["records"][0]["project"] = json!("__inbox__");
    data["sessions"] = json!([{"id":"s1","project":"__inbox__","title":"个人对话","updatedAt":"2026-09-23","context":[],"messages":[]}]);
    assert!(validate(data.clone()).is_ok());
    data["tasks"] = json!([{"id":"t1","project":"__inbox__","title":"不允许"}]);
    assert!(validate(data.clone()).is_err());
    data["tasks"] = json!([]);
    data["runs"] = json!([{"id":"run1","project":"__inbox__","metrics":[]}]);
    assert!(validate(data).is_err());
}

#[test]
fn old_schema_three_normalizes_without_discarding_unmigrated_fields() {
    let mut input = fixture();
    input.as_object_mut().unwrap().remove("teams");
    let result = validate(input.clone()).unwrap();
    assert_eq!(result["projects"][0]["space"], "personal");
    assert_eq!(result["teams"], json!([]));
    assert_eq!(result["records"], input["records"]);
    assert_eq!(result["futureExtension"], input["futureExtension"]);
    assert_eq!(
        result["projects"][0]["extra"],
        input["projects"][0]["extra"]
    );
    assert!(input["projects"][0].get("space").is_none());
}

#[test]
fn experiment_migration_is_idempotent_and_does_not_recreate_removed_experiments() {
    let mut old = fixture();
    old.as_object_mut().unwrap().remove("experiments");
    old["projects"][0]["path"] = json!("F:/existing/code");
    old["projects"][0]["updatedAt"] = Value::Null;
    old["projects"][0]["runConfigurations"] = json!([{"id":"cfg","name":"train"}]);
    let migrated = validate(old).unwrap();
    assert_eq!(migrated["experiments"][0]["project"], "p1");
    assert_eq!(migrated["experiments"][0]["root"], "");
    assert_eq!(
        migrated["experiments"][0]["runConfigurations"][0]["id"],
        "cfg"
    );
    assert_eq!(migrated["projects"][0]["path"], "F:/existing/code");
    assert_eq!(validate(migrated.clone()).unwrap(), migrated);
    let mut removed = migrated;
    removed["experiments"] = json!([]);
    assert_eq!(validate(removed).unwrap()["experiments"], json!([]));
}

#[test]
fn experiment_ownership_and_unique_default_directory_are_validated() {
    let base = validate(fixture()).unwrap();
    let mut other = base.clone();
    other["experiments"][0]["project"] = json!("unknown");
    assert!(validate(other).is_err());
    let mut duplicate = base.clone();
    let mut experiment = duplicate["experiments"][0].clone();
    experiment["id"] = json!("second");
    duplicate["experiments"]
        .as_array_mut()
        .unwrap()
        .push(experiment);
    assert!(validate(duplicate).is_err());
    let mut directory = base;
    directory["experiments"][0]["source"] = json!("existing");
    assert!(validate(directory).is_err());
}

#[test]
fn python_binding_is_optional_and_invalid_environment_metadata_is_rejected() {
    let base = validate(fixture()).unwrap();
    assert!(base["experiments"][0].get("python").is_none());
    let valid = json!({"executable":"F:/env/Scripts/python.exe","prefix":"F:/env","version":"3.12.9","manager":"venv"});
    let mut configured = base.clone();
    configured["experiments"][0]["python"] = valid.clone();
    assert_eq!(
        validate(configured).unwrap()["experiments"][0]["python"],
        valid
    );
    let mut unknown = valid.clone();
    unknown["manager"] = json!("unknown");
    for invalid in [json!("python"), json!({}), unknown] {
        let mut data = base.clone();
        data["experiments"][0]["python"] = invalid;
        assert!(validate(data).is_err());
    }
    for field in ["executable", "prefix", "version", "manager"] {
        let mut data = base.clone();
        data["experiments"][0]["python"] = valid.clone();
        data["experiments"][0]["python"][field] = json!("");
        assert!(validate(data).is_err());
    }
}

#[test]
fn rejects_invalid_relations_teams_ids_and_text() {
    let mut data = fixture();
    data["records"][0]["project"] = json!("missing");
    assert!(validate(data).is_err());
    let mut data = fixture();
    let duplicate = data["records"][0].clone();
    data["records"].as_array_mut().unwrap().push(duplicate);
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["records"][0]["body"] = json!({});
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["projects"][0]["space"] = json!("unknown");
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["teams"] = json!({"invalid":"not array"});
    assert!(validate(data).is_err());
    assert!(parse(b"{broken").is_err());
}

#[test]
fn invalid_metrics_messages_quotes_and_revision_are_rejected() {
    let mut data = fixture();
    data["runs"] = json!([{"id":"run","project":"p1","metrics":[{"name":"loss","value":"NaN"}]}]);
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["sessions"] =
        json!([{"id":"s","project":"p1","context":[],"messages":[{"role":"system","text":"x"}]}]);
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["papers"] = json!([{"id":"paper","projects":["p1"],"tags":[],"quotes":[{"id":"q","text":"quote","page":"one"}]}]);
    assert!(validate(data).is_err());
    let mut data = fixture();
    data["revision"] = json!(-1);
    assert!(validate(data).is_err());
}

#[test]
fn saves_atomically_rejects_stale_revision_and_restores_corrupt_main() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone()).unwrap();
    assert!(storage.load().unwrap().is_none());
    let mut first = fixture();
    first["revision"] = json!(1);
    storage.save(first.clone(), 0).unwrap();
    let mut second = first.clone();
    second["revision"] = json!(2);
    second["records"][0]["body"] = json!("新版内容");
    storage.save(second.clone(), 1).unwrap();
    assert!(storage.save(first, 0).is_err());
    assert_eq!(
        storage.load().unwrap().unwrap()["records"][0]["body"],
        "新版内容"
    );
    fs::write(root.join("workspace.json"), "{broken").unwrap();
    assert!(storage.load().is_err());
    second["revision"] = json!(3);
    assert!(storage.save(second, 2).is_err());
    assert_eq!(
        storage.restore().unwrap()["records"][0]["body"],
        "重要研究内容"
    );
    let copies: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("workspace-unreadable-")
        })
        .collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "{broken");
}

#[test]
fn import_preserves_prior_data_and_invalid_import_does_not_touch_disk() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone()).unwrap();
    let mut data = fixture();
    data["revision"] = json!(1);
    storage.save(data, 0).unwrap();
    let before = fs::read(root.join("workspace.json")).unwrap();
    assert!(storage.import(json!({"schema":3})).is_err());
    assert_eq!(before, fs::read(root.join("workspace.json")).unwrap());
    let imported = storage.import(empty()).unwrap();
    assert_eq!(imported["revision"], 2);
    let archive = fs::read_dir(root)
        .unwrap()
        .flatten()
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("workspace-before-import-")
        })
        .unwrap();
    assert_eq!(
        read_workspace(&archive.path()).unwrap()["records"][0]["body"],
        "重要研究内容"
    );
}

#[test]
fn legacy_copy_preserves_all_files_and_never_mutates_the_source() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("electron");
    fs::create_dir_all(source.join("attachments")).unwrap();
    fs::write(
        source.join("workspace.json"),
        serde_json::to_vec(&fixture()).unwrap(),
    )
    .unwrap();
    fs::write(
        source.join("previous-workspace.json"),
        "legacy browser contents",
    )
    .unwrap();
    fs::write(
        source.join("attachments/550e8400-e29b-41d4-a716-446655440000"),
        b"%PDF-example",
    )
    .unwrap();
    let original = fs::read(source.join("workspace.json")).unwrap();
    let target = temp.path().join("tauri/workspace");
    let storage = Storage::open(target.clone()).unwrap();
    assert_eq!(
        storage.migrate_legacy(&source).unwrap()["records"][0]["body"],
        "重要研究内容"
    );
    assert_eq!(fs::read(source.join("workspace.json")).unwrap(), original);
    assert_eq!(fs::read(target.join("workspace.json")).unwrap(), original);
    assert_eq!(
        fs::read(target.join("attachments/550e8400-e29b-41d4-a716-446655440000")).unwrap(),
        b"%PDF-example"
    );
    assert_eq!(
        fs::read_to_string(target.join("previous-workspace.json")).unwrap(),
        "legacy browser contents"
    );
    assert!(storage.migrate_legacy(&source).is_err());
}

#[test]
fn failed_migration_does_not_publish_a_partial_workspace() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("electron");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("workspace.json"), "{invalid").unwrap();
    let target = temp.path().join("new/workspace");
    let storage = Storage::open(target.clone()).unwrap();
    assert!(storage.migrate_legacy(&source).is_err());
    assert!(!target.exists());
}

#[test]
fn concurrent_saves_allow_one_revision_winner_and_single_process_owner() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = std::sync::Arc::new(Storage::open(root.clone()).unwrap());
    assert!(Storage::open(root.clone()).is_err());
    let mut handles = Vec::new();
    for _ in 0..2 {
        let storage = storage.clone();
        handles.push(std::thread::spawn(move || {
            let mut data = fixture();
            data["revision"] = json!(1);
            storage.save(data, 0).is_ok()
        }));
    }
    let winners = handles
        .into_iter()
        .map(|h| usize::from(h.join().unwrap()))
        .sum::<usize>();
    assert_eq!(winners, 1);
    assert_eq!(storage.load().unwrap().unwrap()["revision"], 1);
    drop(storage);
    assert!(Storage::open(root).is_ok());
}

#[test]
fn export_cannot_overwrite_managed_files() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone()).unwrap();
    let mut data = fixture();
    data["revision"] = json!(1);
    storage.save(data, 0).unwrap();
    assert!(storage.export(&root.join("workspace.json")).is_err());
    let destination = temp.path().join("export.json");
    storage.export(&destination).unwrap();
    assert_eq!(
        read_workspace(&destination).unwrap()["records"][0]["body"],
        "重要研究内容"
    );
}

#[cfg(windows)]
#[test]
fn migration_rejects_directory_junctions_without_following_them() {
    use std::os::windows::process::CommandExt;
    let temp = tempdir().unwrap();
    let source = temp.path().join("electron");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        source.join("workspace.json"),
        serde_json::to_vec(&fixture()).unwrap(),
    )
    .unwrap();
    fs::write(outside.join("private.txt"), "must not copy").unwrap();
    // Junction creation needs no symlink privilege. Paths come only from tempfile.
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(source.join("attachments"))
        .arg(&outside)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(status.status.success());
    let target = temp.path().join("tauri/workspace");
    let storage = Storage::open(target.clone()).unwrap();
    assert!(storage.migrate_legacy(&source).is_err());
    assert!(!target.exists());
    // Remove the junction itself, never recursively traverse the linked target.
    fs::remove_dir(source.join("attachments")).unwrap();
    assert_eq!(
        fs::read_to_string(outside.join("private.txt")).unwrap(),
        "must not copy"
    );
}
