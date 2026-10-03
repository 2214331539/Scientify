use scientify_core::research::{ResearchFiles, MAX_TEXT_BYTES};
use std::{fs, path::Path};
use tempfile::tempdir;

#[test]
fn creates_reads_updates_and_preserves_external_edits() {
    let temp = tempdir().unwrap();
    let files = ResearchFiles::new(temp.path().join("data"));
    let root = files.project_root("p1", None).unwrap();
    let first = files.write(&root, "研究/main.md", "第一稿", None).unwrap();
    assert_eq!(files.read(&root, "研究/main.md").unwrap().content, "第一稿");
    assert!(files.write(&root, "研究/main.md", "覆盖", None).is_err());
    let second = files
        .write(&root, "研究/main.md", "第二稿", Some(&first.version))
        .unwrap();
    assert_ne!(first.version, second.version);
    assert!(files
        .write(&root, "研究/main.md", "过期", Some(&first.version))
        .is_err());
    fs::write(root.join("研究/main.md"), "外部修改").unwrap();
    assert!(files
        .write(&root, "研究/main.md", "应用修改", Some(&second.version))
        .is_err());
    assert_eq!(
        fs::read_to_string(root.join("研究/main.md")).unwrap(),
        "外部修改"
    );
    assert_eq!(
        fs::read_dir(temp.path().join("data/recovery/files"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn code_tree_omits_python_environment_dependencies_but_keeps_project_sources() {
    let fixture = tempdir().unwrap();
    let files = ResearchFiles::new(fixture.path().join("data"));
    let root = files.project_root("p1", None).unwrap();
    files
        .write(&root, "train.py", "print('research')", None)
        .unwrap();
    for folder in [".venv", ".conda", "venv", "custom-python", "custom-conda"] {
        let path = root.join(folder);
        fs::create_dir_all(path.join("Lib/site-packages")).unwrap();
        fs::write(
            path.join("Lib/site-packages/dependency.py"),
            "# third party",
        )
        .unwrap();
        if folder == "venv" || folder == "custom-python" {
            fs::write(path.join("pyvenv.cfg"), "home = base").unwrap();
        }
        if folder == "custom-conda" {
            fs::create_dir(path.join("conda-meta")).unwrap();
        }
    }
    let entries = files.list(&root).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "train.py");
    assert!(root
        .join("custom-python/Lib/site-packages/dependency.py")
        .is_file());
}

#[test]
fn concurrent_writes_have_one_winner_for_the_same_base() {
    use std::sync::{Arc, Barrier};
    let temp = tempdir().unwrap();
    let files = Arc::new(ResearchFiles::new(temp.path().join("data")));
    let root = files.project_root("p1", None).unwrap();
    let initial = files.write(&root, "main.md", "base", None).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|content| {
            let (files, root, barrier, version) = (
                files.clone(),
                root.clone(),
                barrier.clone(),
                initial.version.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                files.write(&root, "main.md", content, Some(&version))
            })
        })
        .collect();
    barrier.wait();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|h| h.join().unwrap().ok())
            .count(),
        1
    );
    assert!(matches!(
        files.read(&root, "main.md").unwrap().content.as_str(),
        "one" | "two"
    ));
}

#[test]
fn ancestor_project_cannot_read_or_overwrite_internal_metadata() {
    let temp = tempdir().unwrap();
    let data = temp.path().join(".tauri-data/workspace");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("workspace.json"), "metadata").unwrap();
    fs::write(
        data.parent().unwrap().join(".workspace.lock"),
        "process lock",
    )
    .unwrap();
    let files = ResearchFiles::new(data.clone());
    let root = files
        .project_root("external", Some(temp.path().to_str().unwrap()))
        .unwrap();
    assert!(files
        .read(&root, ".tauri-data/workspace/workspace.json")
        .is_err());
    assert!(files.read(&root, ".tauri-data/.workspace.lock").is_err());
    assert!(files
        .write(&root, ".tauri-data/.workspace.lock", "x", None)
        .is_err());
    assert!(files
        .write(&root, ".tauri-data/workspace/new.txt", "x", None)
        .is_err());
    #[cfg(windows)]
    {
        assert!(files
            .read(&root, ".TAURI-DATA/WORKSPACE/workspace.json")
            .is_err());
        assert!(files
            .write(&root, ".TAURI-DATA/WORKSPACE/new.txt", "x", None)
            .is_err());
    }
    assert!(!files
        .list(&root)
        .unwrap()
        .iter()
        .any(|f| f.path.contains("workspace.json")));
    assert!(files
        .project_root("external", Some(data.to_str().unwrap()))
        .is_err());
    let managed = files.project_root("managed", None).unwrap();
    assert!(files.write(&managed, "paper.md", "allowed", None).is_ok());
    assert!(files
        .project_root("external", Some(managed.to_str().unwrap()))
        .is_err());
    assert_eq!(
        fs::read_to_string(data.join("workspace.json")).unwrap(),
        "metadata"
    );
}

#[test]
fn rejects_traversal_absolute_reserved_and_git_paths() {
    let temp = tempdir().unwrap();
    let files = ResearchFiles::new(temp.path().join("data"));
    let root = files.project_root("p1", None).unwrap();
    for path in [
        "../out.txt",
        "a/../../out.txt",
        "a\\..\\out.txt",
        "/root.txt",
        "C:\\out.txt",
        "a:b",
        "./x",
        ".git/config",
        "NUL.txt",
        "folder./x",
        "a//b",
    ] {
        assert!(
            files.write(&root, path, "x", None).is_err(),
            "accepted {path}"
        );
    }
    assert!(!temp.path().join("out.txt").exists());
    assert!(files.project_root("../x", None).is_err());
    assert!(files.project_root("p1", Some("relative")).is_err());
}

#[test]
fn rejects_binary_and_large_text_and_lists_chinese_paths() {
    let temp = tempdir().unwrap();
    let files = ResearchFiles::new(temp.path().join("data"));
    let root = files.project_root("p1", None).unwrap();
    fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
    assert!(files.read(&root, "binary.bin").is_err());
    fs::write(root.join("invalid.txt"), [0xff, 0xfe]).unwrap();
    assert!(files.read(&root, "invalid.txt").is_err());
    assert!(files
        .write(
            &root,
            "large.txt",
            &"x".repeat(MAX_TEXT_BYTES as usize + 1),
            None
        )
        .is_err());
    files
        .write(&root, "实验/代码.py", "print('hello')", None)
        .unwrap();
    assert!(files
        .list(&root)
        .unwrap()
        .iter()
        .any(|f| f.path == "实验/代码.py"));
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join(".git/config"), "private").unwrap();
    assert!(!files
        .list(&root)
        .unwrap()
        .iter()
        .any(|f| f.path.starts_with(".git")));
}

#[test]
fn pdf_import_is_managed_and_ids_cannot_escape() {
    let temp = tempdir().unwrap();
    let files = ResearchFiles::new(temp.path().join("data"));
    let source = temp.path().join("论文.pdf");
    let pdf = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF";
    fs::write(&source, pdf).unwrap();
    let asset = files.import_pdf(&source).unwrap();
    fs::remove_file(&source).unwrap();
    assert_eq!(files.read_pdf(&asset.asset_id).unwrap(), pdf);
    assert_eq!(asset.file_name, "论文.pdf");
    assert!(files.read_pdf("../../workspace.json").is_err());
    fs::write(&source, "not a pdf").unwrap();
    assert!(files.import_pdf(&source).is_err());
}

#[test]
fn linked_directories_cannot_escape_root() {
    let temp = tempdir().unwrap();
    let files = ResearchFiles::new(temp.path().join("data"));
    let root = files.project_root("p1", None).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside").unwrap();
    let link = root.join("link");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Directory junctions do not require Windows developer mode.
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(files.read(&root, "link/secret.txt").is_err());
    assert!(files.write(&root, "link/new.txt", "x", None).is_err());
    assert!(files
        .project_root("p2", Some(link.to_str().unwrap()))
        .is_err());
    assert!(!files
        .list(&root)
        .unwrap()
        .iter()
        .any(|f| f.path.starts_with("link")));
    assert!(!Path::new(&outside).join("new.txt").exists());
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
}
