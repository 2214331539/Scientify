use scientify_core::library::{LocalLibrary, Operation};
use std::fs;
fn fixture() -> (tempfile::TempDir, LocalLibrary, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("papers");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.pdf"), b"%PDF-1.4 first").unwrap();
    let lib = LocalLibrary::new(temp.path().join("data"));
    lib.mount("project", &root).unwrap();
    (temp, lib, root)
}

#[test]
fn unfinished_transaction_blocks_writes_without_losing_recovery_evidence() {
    let (_temp, lib, root) = fixture();
    let paper = lib.open("project", "a.pdf").unwrap();
    lib.save_note("project", &paper.id, "keep this note", None, None)
        .unwrap();
    let marker = root.join(".scientify/operation.json");
    fs::write(&marker, r#"{"interrupted":true}"#).unwrap();
    assert!(lib
        .operate("project", Operation::Mkdir { path: "new".into() })
        .is_err());
    assert!(lib.open("project", "a.pdf").is_err());
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        r#"{"interrupted":true}"#
    );
    assert_eq!(
        fs::read_to_string(root.join("a.notes.md")).unwrap(),
        "keep this note"
    );
    assert!(root.join("a.pdf").exists());
    assert!(!root.join("new").exists());
}

#[test]
fn refuses_unrelated_target_note_and_preserves_pair_when_note_move_fails() {
    let (_t, lib, root) = fixture();
    let p = lib.open("project", "a.pdf").unwrap();
    fs::write(root.join("b.notes.md"), "unrelated").unwrap();
    assert!(lib
        .operate(
            "project",
            Operation::Transfer {
                path: "a.pdf".into(),
                destination: "b.pdf".into(),
                copy: false
            }
        )
        .is_err());
    assert!(root.join("a.pdf").exists());
    assert!(!root.join("b.pdf").exists());
    assert_eq!(
        fs::read_to_string(root.join("b.notes.md")).unwrap(),
        "unrelated"
    );
    lib.save_note("project", &p.id, "original", None, None)
        .unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(root.join("a.notes.md"))
            .unwrap();
        assert!(lib
            .operate(
                "project",
                Operation::Transfer {
                    path: "a.pdf".into(),
                    destination: "c.pdf".into(),
                    copy: false
                }
            )
            .is_err());
        assert!(root.join("a.pdf").exists());
        assert!(!root.join("c.pdf").exists());
    }
}

#[test]
fn migration_copies_without_changing_originals_and_duplicate_imports_get_new_ids() {
    let (_t, lib, root) = fixture();
    let source = root.parent().unwrap().join("legacy.pdf");
    fs::write(&source, b"%PDF-1.4 legacy").unwrap();
    for _ in 0..2 {
        lib.import_files(
            "project",
            &[(source.clone(), "legacy.pdf".into(), Some("old note".into()))],
        )
        .unwrap();
    }
    let result = lib.scan("project").unwrap();
    assert_eq!(result.papers.len(), 2);
    assert_ne!(result.papers[0].id, result.papers[1].id);
    assert_eq!(fs::read(&source).unwrap(), b"%PDF-1.4 legacy");
    assert!(root.join("legacy (1).notes.md").exists());
}
#[test]
fn boundaries_corrupt_index_and_empty_notes() {
    let (_t, lib, root) = fixture();
    for p in [
        "../outside.pdf",
        ".scientify/library.json",
        "C:/secret.pdf",
        "a/../b",
        "CON.pdf",
    ] {
        assert!(lib.open("project", p).is_err());
    }
    let p = lib.open("project", "a.pdf").unwrap();
    assert!(lib.note("project", &p.id).unwrap().revision.is_none());
    lib.save_note("project", &p.id, "", None, None).unwrap();
    assert!(!root.join("a.notes.md").exists());
    fs::write(root.join(".scientify/library.json"), "broken").unwrap();
    assert!(lib.open("project", "a.pdf").is_err());
    assert_eq!(
        fs::read_to_string(root.join(".scientify/library.json")).unwrap(),
        "broken"
    );
}
#[test]
fn pair_moves_copies_and_refuses_overwrite() {
    let (_t, lib, root) = fixture();
    let p = lib.open("project", "a.pdf").unwrap();
    lib.save_note("project", &p.id, "note", None, None).unwrap();
    lib.operate(
        "project",
        Operation::Transfer {
            path: "a.pdf".into(),
            destination: "b.pdf".into(),
            copy: false,
        },
    )
    .unwrap();
    assert!(!root.join("a.pdf").exists());
    assert_eq!(fs::read_to_string(root.join("b.notes.md")).unwrap(), "note");
    let moved = lib.open("project", "b.pdf").unwrap();
    assert_eq!(p.id, moved.id);
    lib.operate(
        "project",
        Operation::Transfer {
            path: "b.pdf".into(),
            destination: "c.pdf".into(),
            copy: true,
        },
    )
    .unwrap();
    assert_ne!(p.id, lib.open("project", "c.pdf").unwrap().id);
    assert!(lib
        .operate(
            "project",
            Operation::Transfer {
                path: "b.pdf".into(),
                destination: "c.pdf".into(),
                copy: false
            }
        )
        .is_err());
    assert_eq!(fs::read_to_string(root.join("b.notes.md")).unwrap(), "note");
}
#[test]
fn conflict_and_copy_preserve_external_text() {
    let (_t, lib, root) = fixture();
    let p = lib.open("project", "a.pdf").unwrap();
    let n = lib
        .save_note("project", &p.id, "first", None, None)
        .unwrap();
    fs::write(root.join("a.notes.md"), "external").unwrap();
    assert!(lib
        .save_note("project", &p.id, "draft", n.revision.as_deref(), None)
        .is_err());
    lib.save_note("project", &p.id, "draft", None, Some("copy.md"))
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a.notes.md")).unwrap(),
        "external"
    );
    assert_eq!(fs::read_to_string(root.join("copy.md")).unwrap(), "draft");
}
#[test]
fn recycle_failure_rolls_back_whole_pair() {
    let (_t, lib, root) = fixture();
    let p = lib.open("project", "a.pdf").unwrap();
    lib.save_note("project", &p.id, "note", None, None).unwrap();
    assert!(lib
        .delete_with("project", "a.pdf", |_| Err("trash unavailable".into()))
        .is_err());
    assert!(root.join("a.pdf").exists());
    assert_eq!(fs::read_to_string(root.join("a.notes.md")).unwrap(), "note");
}
#[test]
fn unique_external_rename_recovers_identity_but_ambiguous_candidates_do_not() {
    let (_t, lib, root) = fixture();
    let p = lib.open("project", "a.pdf").unwrap();
    lib.save_note("project", &p.id, "note", None, None).unwrap();
    fs::rename(root.join("a.pdf"), root.join("renamed.pdf")).unwrap();
    let scan = lib.scan("project").unwrap();
    assert_eq!(scan.papers[0].id, p.id);
    assert_eq!(scan.papers[0].path, "renamed.pdf");
    assert!(root.join("renamed.notes.md").exists());
    fs::rename(root.join("renamed.pdf"), root.join("one.pdf")).unwrap();
    fs::copy(root.join("one.pdf"), root.join("two.pdf")).unwrap();
    let scan = lib.scan("project").unwrap();
    assert_eq!(scan.papers[0].path, "renamed.pdf");
    assert!(!scan.warnings.is_empty());
    assert!(root.join("renamed.notes.md").exists());
}
#[test]
fn folder_transfer_updates_descendants_and_recycle_manifest() {
    let (_t, lib, root) = fixture();
    lib.operate(
        "project",
        Operation::Mkdir {
            path: "folder".into(),
        },
    )
    .unwrap();
    let p = lib.open("project", "a.pdf").unwrap();
    lib.save_note("project", &p.id, "note", None, None).unwrap();
    lib.operate(
        "project",
        Operation::Transfer {
            path: "a.pdf".into(),
            destination: "folder/a.pdf".into(),
            copy: false,
        },
    )
    .unwrap();
    lib.operate(
        "project",
        Operation::Transfer {
            path: "folder".into(),
            destination: "moved".into(),
            copy: false,
        },
    )
    .unwrap();
    assert_eq!(lib.scan("project").unwrap().papers[0].path, "moved/a.pdf");
    let destination = root.parent().unwrap().join("fake-trash");
    lib.delete_with("project", "moved", |package| {
        assert!(package.join("restore.json").exists());
        fs::rename(package, &destination).map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(!root.join("moved").exists());
    assert!(destination.join("0/a.notes.md").exists());
    assert_eq!(lib.scan("project").unwrap().papers[0].id, p.id);
}
