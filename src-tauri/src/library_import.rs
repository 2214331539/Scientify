//! Moving a reference library into a project: Zotero (its database and PDFs),
//! BibTeX or RIS. Folders follow the collections; PDFs already in the library
//! are not copied twice; references and highlights go into each paper's record
//! and a `references.bib` beside them.
use crate::library::{project, trusted, LibraryState};
use crate::AppState;
use scientify_core::library::LocalLibrary;
use scientify_core::references::{self, bibtex, ris, zotero, Catalog, Reference};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The catalog the user is looking at, read once and imported from as previewed.
#[derive(Default)]
pub struct ImportState {
    preview: Mutex<Option<(String, Catalog)>>,
    cancel: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    /// Zotero data folders found on this computer.
    zotero: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionView {
    id: String,
    name: String,
    parent: Option<String>,
    /// Entries filed directly in this collection.
    items: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: String,
    kind: String,
    location: String,
    from_backup: bool,
    collections: Vec<CollectionView>,
    unfiled: usize,
    items: usize,
    pdfs: usize,
    missing: usize,
    notes: usize,
    highlights: usize,
    without_pdf: usize,
    warnings: Vec<String>,
    /// Suggested folder inside the literature folder.
    folder: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    papers: usize,
    duplicates: usize,
    highlights: usize,
    notes: usize,
    references: usize,
    without_pdf: usize,
    missing: usize,
    failed: Vec<String>,
    cancelled: bool,
    folder: String,
}

#[tauri::command]
pub fn library_import_sources<R: tauri::Runtime>(
    view: tauri::Webview<R>,
) -> Result<Sources, String> {
    trusted(&view)?;
    Ok(Sources {
        zotero: zotero::locate()
            .into_iter()
            .map(|dir| dir.display().to_string())
            .collect(),
    })
}

/// Lets the user point at a Zotero data folder (or a .bib / .ris file) by hand.
#[tauri::command]
pub async fn library_import_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    kind: String,
) -> Result<Option<String>, String> {
    trusted(&view)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let picked = if kind == "zotero" {
            dialog.blocking_pick_folder()
        } else {
            dialog
                .add_filter("BibTeX / RIS", &["bib", "bibtex", "ris", "txt"])
                .blocking_pick_file()
        };
        picked
            .map(|p| {
                p.into_path()
                    .map(|p| p.display().to_string())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_catalog(kind: &str, path: &str) -> Result<(Catalog, bool, String, String), String> {
    if kind == "zotero" {
        let dir = PathBuf::from(path);
        if !dir.join("zotero.sqlite").is_file() {
            return Err("这个文件夹里没有 zotero.sqlite。请选择 Zotero 的数据文件夹（设置 → 高级 → 文件和文件夹里能看到）。".into());
        }
        let scratch =
            std::env::temp_dir().join(format!("scientify-zotero-{}", uuid::Uuid::new_v4()));
        let result = zotero::read(&dir, &scratch);
        let _ = std::fs::remove_dir_all(&scratch);
        let snapshot = result?;
        return Ok((
            snapshot.catalog,
            snapshot.from_backup,
            "zotero".into(),
            "Zotero".into(),
        ));
    }
    let file = PathBuf::from(path);
    let bytes = std::fs::read(&file).map_err(|e| format!("无法读取文件：{e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("文件超过 64 MiB。".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let base = file.parent().map(PathBuf::from).unwrap_or_default();
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "导入".into());
    let is_ris = file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ris"))
        || text
            .trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with("TY  -");
    Ok(if is_ris {
        (ris::parse(&text, &base), false, "ris".into(), stem)
    } else {
        (bibtex::parse(&text, &base), false, "bibtex".into(), stem)
    })
}

/// Reads a source and says what importing it would bring.
#[tauri::command]
pub async fn library_import_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    kind: String,
    path: Option<String>,
) -> Result<Preview, String> {
    trusted(&view)?;
    let path = match path {
        Some(path) => path,
        None if kind == "zotero" => zotero::locate()
            .first()
            .map(|d| d.display().to_string())
            .ok_or("没有找到 Zotero 数据文件夹。请手动选择。")?,
        None => return Err("请选择要导入的文件。".into()),
    };
    let location = path.clone();
    let (catalog, from_backup, kind, folder) =
        tauri::async_runtime::spawn_blocking(move || read_catalog(&kind, &path))
            .await
            .map_err(|e| e.to_string())??;
    let mut direct: HashMap<&str, usize> = HashMap::new();
    let mut unfiled = 0;
    for item in &catalog.items {
        match item.collections.first() {
            Some(first) => *direct.entry(first.as_str()).or_default() += 1,
            None => unfiled += 1,
        }
    }
    let papers = catalog.items.iter().filter(|i| !i.standalone);
    let preview = Preview {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        location,
        from_backup,
        collections: catalog
            .collections
            .iter()
            .map(|c| CollectionView {
                id: c.id.clone(),
                name: c.name.clone(),
                parent: c.parent.clone(),
                items: direct.get(c.id.as_str()).copied().unwrap_or(0),
            })
            .collect(),
        unfiled,
        items: papers.clone().count(),
        pdfs: catalog.items.iter().map(|i| i.pdfs.len()).sum(),
        missing: catalog.items.iter().map(|i| i.missing.len()).sum(),
        notes: catalog.items.iter().map(|i| i.notes.len()).sum(),
        highlights: catalog
            .items
            .iter()
            .flat_map(|i| &i.pdfs)
            .map(|p| p.annotations.len())
            .sum(),
        without_pdf: papers.filter(|i| i.pdfs.is_empty()).count(),
        warnings: catalog.warnings.clone(),
        folder,
    };
    *app.state::<ImportState>()
        .preview
        .lock()
        .map_err(|e| e.to_string())? = Some((preview.id.clone(), catalog));
    Ok(preview)
}

/// A file or folder name the literature folder (and every OS) accepts.
fn safe_name(name: &str, fallback: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    out = out.chars().take(120).collect::<String>();
    out = out.trim_end_matches(['.', ' ']).trim().to_string();
    if out.starts_with('.') {
        out.replace_range(0..1, "_");
    }
    let upper = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.push('_');
    }
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.into()
    } else {
        format!("{folder}/{name}")
    }
}

fn card(reference: &Reference, notes: &[String]) -> String {
    let mut lines = vec![format!("# {}", reference.title)];
    let byline: Vec<String> = [
        (!reference.authors.is_empty()).then(|| reference.authors.join("; ")),
        reference.venue.clone(),
        reference.year.clone(),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !byline.is_empty() {
        lines.push(byline.join(" · "));
    }
    if let Some(doi) = &reference.doi {
        lines.push(format!("DOI: https://doi.org/{doi}"));
    } else if let Some(url) = &reference.url {
        lines.push(url.clone());
    }
    let mut text = lines.join("\n\n");
    for note in notes {
        text.push_str("\n\n");
        text.push_str(note);
    }
    text.push('\n');
    text
}

#[tauri::command]
pub fn library_import_cancel<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    imports: State<'_, ImportState>,
) -> Result<(), String> {
    trusted(&view)?;
    imports.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Imports the previewed catalog into `folder` of the project's literature folder.
/// `collections` limits it to those collection ids (`""` is the unfiled entries).
#[tauri::command]
pub async fn library_import_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    preview_id: String,
    collections: Option<Vec<String>>,
    folder: String,
) -> Result<Report, String> {
    trusted(&view)?;
    project(&state, &project_id)?;
    crate::collaboration::permissions::require_write(&state.storage, &project_id, "library")?;
    let catalog = match app
        .state::<ImportState>()
        .preview
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
    {
        Some((id, catalog)) if *id == preview_id => catalog.clone(),
        _ => return Err("导入预览已过期，请重新选择来源。".into()),
    };
    app.state::<ImportState>()
        .cancel
        .store(false, Ordering::SeqCst);
    let service = app.state::<LibraryState>().service.clone();
    let handle = app.clone();
    let id = project_id.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let root = service.root(&id)?.ok_or("请先打开文献文件夹。")?;
        let _lease = crate::code::Lease::mutation(&root)?;
        import(
            &service,
            &id,
            &catalog,
            collections,
            &folder,
            &handle.state::<ImportState>().cancel,
            |done, total, title| {
                let _ = handle.emit(
                    "library-import-progress",
                    serde_json::json!({ "done": done, "total": total, "title": title }),
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "library-changed",
        serde_json::json!({ "projectId": project_id, "error": null }),
    );
    Ok(report)
}

/// Copies a catalog into `folder` of a project's literature folder: collections
/// become folders, each PDF is copied once, notes sit beside their papers, and
/// references and highlights go into paper records and `references.bib`.
pub(crate) fn import(
    service: &LocalLibrary,
    id: &str,
    catalog: &Catalog,
    collections: Option<Vec<String>>,
    folder: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<Report, String> {
    let base = folder
        .split('/')
        .filter(|s| !s.trim().is_empty())
        .map(|s| safe_name(s, "导入"))
        .collect::<Vec<_>>()
        .join("/");
    // Collection id → folder path under `base`.
    let parents: HashMap<&str, (&str, Option<&str>)> = catalog
        .collections
        .iter()
        .map(|c| (c.id.as_str(), (c.name.as_str(), c.parent.as_deref())))
        .collect();
    let path_of = |id: &str| {
        let mut parts = vec![];
        let mut at = Some(id);
        let mut seen = HashSet::new();
        while let Some(current) = at.filter(|c| seen.insert(*c)) {
            let Some((name, parent)) = parents.get(current) else {
                break;
            };
            parts.push(safe_name(name, "未命名"));
            at = *parent;
        }
        parts.reverse();
        join(&base, &parts.join("/"))
    };
    let selected: Option<HashSet<String>> = collections.map(|c| c.into_iter().collect());
    let chosen: Vec<_> = catalog
        .items
        .iter()
        .filter_map(|item| match &selected {
            None => Some((item, item.collections.first().cloned())),
            Some(set) => {
                if item.collections.is_empty() {
                    set.contains("").then_some((item, None))
                } else {
                    item.collections
                        .iter()
                        .find(|c| set.contains(*c))
                        .map(|c| (item, Some(c.clone())))
                }
            }
        })
        .collect();
    let mut report = Report {
        folder: base.clone(),
        ..Default::default()
    };
    let mut bib = vec![];
    let total = chosen.len();
    for (done, (item, collection)) in chosen.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }
        progress(done, total, &item.reference.title);
        let target = match &collection {
            Some(c) => path_of(c),
            None => base.clone(),
        };
        let result = (|| -> Result<(), String> {
            if item.standalone {
                let name = safe_name(&item.reference.title, "笔记");
                if service.add_text(
                    id,
                    &join(&target, &format!("{name}.md")),
                    &item.notes.join("\n\n"),
                )? {
                    report.notes += item.notes.len();
                }
                return Ok(());
            }
            let mut file = None;
            for (n, pdf) in item.pdfs.iter().enumerate() {
                let stem = pdf
                    .name
                    .strip_suffix(".pdf")
                    .or(pdf.name.strip_suffix(".PDF"))
                    .unwrap_or(&pdf.name);
                let name = format!("{}.pdf", safe_name(stem, "paper"));
                let note =
                    (n == 0 && !item.notes.is_empty()).then(|| item.notes.join("\n\n---\n\n"));
                let (binding, new) =
                    service.add_pdf(id, &target, &pdf.path, &name, note.as_deref())?;
                if new {
                    report.papers += 1;
                    if note.is_some() {
                        report.notes += item.notes.len();
                    }
                } else {
                    report.duplicates += 1;
                }
                report.highlights += service.merge_record(
                    id,
                    &binding.fingerprint,
                    &item.reference,
                    &pdf.annotations,
                )?;
                if file.is_none() {
                    let prefix = if base.is_empty() {
                        String::new()
                    } else {
                        format!("{base}/")
                    };
                    file = Some(
                        binding
                            .path
                            .strip_prefix(&prefix)
                            .unwrap_or(&binding.path)
                            .to_string(),
                    );
                }
            }
            if item.pdfs.is_empty() {
                report.without_pdf += 1;
                // Notes without a PDF to sit beside become a card of their own.
                if !item.notes.is_empty() {
                    let name = safe_name(&item.reference.title, "条目");
                    if service.add_text(
                        id,
                        &join(&target, &format!("{name}.md")),
                        &card(&item.reference, &item.notes),
                    )? {
                        report.notes += item.notes.len();
                    }
                }
            }
            report.missing += item.missing.len();
            bib.push((
                item.reference.key.clone(),
                references::to_bibtex(&item.reference, file.as_deref()),
            ));
            Ok(())
        })();
        if let Err(error) = result {
            if report.failed.len() < 20 {
                let title = if item.reference.title.is_empty() {
                    "未命名条目"
                } else {
                    item.reference.title.as_str()
                };
                report.failed.push(format!("{title}：{error}"));
            }
        }
    }
    if !bib.is_empty() {
        report.references = service.merge_bibliography(id, &join(&base, "references.bib"), &bib)?;
    }
    progress(total, total, "");
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, LocalLibrary, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("papers");
        std::fs::create_dir(&root).unwrap();
        let service = LocalLibrary::new(temp.path().join("data"));
        service.mount("project", &root).unwrap();
        (temp, service, root)
    }

    #[test]
    fn imports_collections_as_folders_once_with_notes_highlights_and_references() {
        use scientify_core::references::{Annotation, Attachment, Collection, Item};
        let (temp, service, root) = library();
        let source = temp.path().join("zotero");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("grasp.pdf"), b"%PDF-1.5 grasp").unwrap();
        let paper = Item {
            reference: Reference {
                key: "lovelace2023learning".into(),
                title: "Learning to Grasp".into(),
                authors: vec!["Lovelace, Ada".into()],
                year: Some("2023".into()),
                ..Default::default()
            },
            collections: vec!["c11".into()],
            pdfs: vec![Attachment {
                path: source.join("grasp.pdf"),
                name: "grasp.pdf".into(),
                annotations: vec![Annotation {
                    id: "zotero:A1".into(),
                    kind: "highlight".into(),
                    page: 2,
                    rects: vec![[10.0, 20.0, 110.0, 32.0]],
                    ..Default::default()
                }],
            }],
            notes: vec!["Key **idea**".into()],
            ..Default::default()
        };
        let catalog = Catalog {
            items: vec![
                paper,
                Item {
                    reference: Reference {
                        key: "nopdf".into(),
                        title: "Only a reference".into(),
                        ..Default::default()
                    },
                    missing: vec!["gone.pdf".into()],
                    ..Default::default()
                },
                Item {
                    reference: Reference {
                        title: "Reading list".into(),
                        ..Default::default()
                    },
                    notes: vec!["# Reading list".into()],
                    standalone: true,
                    ..Default::default()
                },
            ],
            collections: vec![
                Collection {
                    id: "c10".into(),
                    name: "Robots: real".into(),
                    parent: None,
                },
                Collection {
                    id: "c11".into(),
                    name: "Grasping".into(),
                    parent: Some("c10".into()),
                },
            ],
            warnings: vec![],
        };
        let cancel = AtomicBool::new(false);
        let mut steps = vec![];
        let report = import(
            &service,
            "project",
            &catalog,
            None,
            "Zotero",
            &cancel,
            |done, total, _| steps.push((done, total)),
        )
        .unwrap();
        assert_eq!(steps.first(), Some(&(0, 3)));
        assert_eq!(steps.last(), Some(&(3, 3)));
        assert_eq!(report.papers, 1);
        assert_eq!(report.highlights, 1);
        assert_eq!(report.notes, 2);
        assert_eq!(report.references, 2);
        assert_eq!(report.without_pdf, 1);
        assert_eq!(report.missing, 1);
        let pdf = root.join("Zotero/Robots_ real/Grasping/grasp.pdf");
        assert!(pdf.is_file());
        assert_eq!(
            std::fs::read_to_string(root.join("Zotero/Robots_ real/Grasping/grasp.notes.md"))
                .unwrap(),
            "Key **idea**"
        );
        assert!(root.join("Zotero/Reading list.md").is_file());
        let bib = std::fs::read_to_string(root.join("Zotero/references.bib")).unwrap();
        assert!(bib.contains("@misc{lovelace2023learning,"));
        assert!(bib.contains("file = {Robots_ real/Grasping/grasp.pdf}"));
        let listed = service.references("project").unwrap();
        assert_eq!(
            listed.values().next().unwrap()["title"],
            "Learning to Grasp"
        );

        // Importing again copies nothing twice and keeps the highlights single.
        let again = import(
            &service,
            "project",
            &catalog,
            None,
            "Zotero",
            &cancel,
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(
            (
                again.papers,
                again.duplicates,
                again.highlights,
                again.references
            ),
            (0, 1, 0, 0)
        );

        // Choosing only unfiled entries leaves the collections out.
        let (_t, other, other_root) = library();
        let only = import(
            &other,
            "project",
            &catalog,
            Some(vec!["".into()]),
            "",
            &cancel,
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(only.papers, 0);
        assert!(other_root.join("Reading list.md").is_file());
        assert!(other_root.join("references.bib").is_file());
    }

    /// `SCIENTIFY_ZOTERO_DIR=… cargo test -p scientify -- --ignored live_zotero_import`
    #[test]
    #[ignore]
    fn live_zotero_import() {
        let dir =
            PathBuf::from(std::env::var_os("SCIENTIFY_ZOTERO_DIR").expect("SCIENTIFY_ZOTERO_DIR"));
        let (temp, service, root) = library();
        let snapshot = zotero::read(&dir, &temp.path().join("scratch")).unwrap();
        let report = import(
            &service,
            "project",
            &snapshot.catalog,
            None,
            "Zotero",
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .unwrap();
        println!(
            "papers={} duplicates={} notes={} highlights={} references={} failed={:?}",
            report.papers,
            report.duplicates,
            report.notes,
            report.highlights,
            report.references,
            report.failed
        );
        for entry in std::fs::read_dir(root.join("Zotero"))
            .unwrap()
            .flatten()
            .take(4)
        {
            println!("{}", entry.file_name().to_string_lossy());
        }
    }

    #[test]
    fn names_are_safe_on_every_system() {
        assert_eq!(safe_name("A/B: c?", "x"), "A_B_ c_");
        assert_eq!(safe_name("  .hidden  ", "x"), "_hidden");
        assert_eq!(safe_name("CON", "x"), "CON_");
        assert_eq!(safe_name("dots...", "x"), "dots");
        assert_eq!(safe_name("", "未命名"), "未命名");
    }
}
