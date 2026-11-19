//! Zotero's own library: the `zotero.sqlite` database and the `storage` folder of PDFs.
use super::{
    clean_doi, html, year_of, Annotation, Attachment, Catalog, Collection, Item, Reference,
};
use rusqlite::{Connection, OpenFlags};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Zotero's profile folders, where `prefs.js` records a custom data folder.
fn profiles() -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Zotero/Zotero/Profiles"));
    }
    if let Some(home) = home() {
        roots.push(home.join("Library/Application Support/Zotero/Profiles"));
        roots.push(home.join(".zotero/zotero"));
    }
    roots
        .into_iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flat_map(|dir| dir.flatten().map(|e| e.path().join("prefs.js")))
        .filter(|prefs| prefs.is_file())
        .collect()
}

/// A string preference from `prefs.js`: `user_pref("name", "value");`.
fn preference(text: &str, name: &str) -> Option<String> {
    let needle = format!("user_pref(\"{name}\",");
    let line = text.lines().find(|l| l.trim_start().starts_with(&needle))?;
    let value = line.split_once(',')?.1.trim();
    let value = value.strip_prefix('"')?;
    let end = value.rfind("\");")?;
    Some(value[..end].replace("\\\\", "\\").replace("\\\"", "\""))
}

/// Where linked files given as `attachments:…` are relative to, if Zotero has a base folder.
fn base_attachment_path() -> Option<PathBuf> {
    profiles().into_iter().find_map(|prefs| {
        let text = fs::read_to_string(prefs).ok()?;
        preference(&text, "extensions.zotero.baseAttachmentPath").map(PathBuf::from)
    })
}

/// Zotero data folders on this computer: the one set in Zotero's preferences, then `~/Zotero`.
pub fn locate() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = vec![];
    for prefs in profiles() {
        if let Ok(text) = fs::read_to_string(&prefs) {
            if let Some(dir) = preference(&text, "extensions.zotero.dataDir") {
                found.push(PathBuf::from(dir));
            }
        }
    }
    if let Some(home) = home() {
        found.push(home.join("Zotero"));
    }
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|dir| dir.join("zotero.sqlite").is_file())
        .filter(|dir| seen.insert(dir.to_string_lossy().to_lowercase()))
        .collect()
}

fn open(path: &Path) -> Option<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection
        .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
        .ok()?;
    Some(connection)
}

/// Zotero keeps its database open, so this reads a copy (with the write-ahead log,
/// where recent changes live). If the live file cannot be copied, Zotero's own
/// periodic backup is the next best; the flag says which one was read.
fn snapshot(dir: &Path, scratch: &Path) -> Result<(Connection, bool), String> {
    fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let copy = scratch.join("zotero.sqlite");
    let wal = scratch.join("zotero.sqlite-wal");
    let _ = fs::remove_file(&wal);
    let live = fs::copy(dir.join("zotero.sqlite"), &copy).and_then(|_| {
        let source = dir.join("zotero.sqlite-wal");
        if source.is_file() {
            fs::copy(source, &wal).map(|_| ())
        } else {
            Ok(())
        }
    });
    if live.is_ok() {
        if let Some(connection) = open(&copy) {
            return Ok((connection, false));
        }
    }
    let _ = fs::remove_file(&wal);
    if fs::copy(dir.join("zotero.sqlite.bak"), &copy).is_ok() {
        if let Some(connection) = open(&copy) {
            return Ok((connection, true));
        }
    }
    Err("无法读取 Zotero 数据库。请关闭 Zotero 后重试。".into())
}

/// Rows of a query; a table an older Zotero does not have reads as empty.
fn rows<T>(
    connection: &Connection,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    let Ok(mut statement) = connection.prepare(sql) else {
        return vec![];
    };
    let Ok(found) = statement.query_map([], map) else {
        return vec![];
    };
    found.flatten().collect()
}

fn kind(item_type: &str) -> &'static str {
    match item_type {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => "article",
        "conferencePaper" => "inproceedings",
        "book" => "book",
        "bookSection" => "incollection",
        "thesis" => "phdthesis",
        "report" => "techreport",
        "manuscript" => "unpublished",
        _ => "misc",
    }
}

pub struct Snapshot {
    pub catalog: Catalog,
    /// The live database was locked; this is Zotero's last backup.
    pub from_backup: bool,
}

/// Reads a Zotero data folder into a catalog. `scratch` holds the database copy.
pub fn read(dir: &Path, scratch: &Path) -> Result<Snapshot, String> {
    let (db, from_backup) = snapshot(dir, scratch)?;
    let base = base_attachment_path();
    let mut catalog = Catalog::default();

    let feeds: HashSet<i64> = rows::<i64>(
        &db,
        "SELECT libraryID FROM libraries WHERE type = 'feed'",
        |r| r.get(0),
    )
    .into_iter()
    .collect();
    let groups: HashMap<i64, String> =
        rows::<(i64, String)>(&db, "SELECT libraryID, name FROM groups", |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .into_iter()
        .collect();
    let deleted: HashSet<i64> = rows::<i64>(&db, "SELECT itemID FROM deletedItems", |r| r.get(0))
        .into_iter()
        .collect();
    let deleted_collections: HashSet<i64> =
        rows::<i64>(&db, "SELECT collectionID FROM deletedCollections", |r| {
            r.get(0)
        })
        .into_iter()
        .collect();

    // A group library is a folder of its own above its collections.
    for (library, name) in &groups {
        if !feeds.contains(library) {
            catalog.collections.push(Collection {
                id: format!("lib:{library}"),
                name: name.clone(),
                parent: None,
            });
        }
    }
    for (id, name, parent, library) in rows(
        &db,
        "SELECT collectionID, collectionName, parentCollectionID, libraryID FROM collections ORDER BY collectionName",
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, i64>(3)?)),
    ) {
        if deleted_collections.contains(&id) || feeds.contains(&library) {
            continue;
        }
        catalog.collections.push(Collection {
            id: format!("c{id}"),
            name,
            parent: match parent {
                Some(parent) => Some(format!("c{parent}")),
                None => groups.contains_key(&library).then(|| format!("lib:{library}")),
            },
        });
    }
    let live_collections: HashSet<String> =
        catalog.collections.iter().map(|c| c.id.clone()).collect();

    let field_sql = |table: &str| {
        format!(
            "SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN {table} f USING (fieldID) JOIN itemDataValues v USING (valueID)"
        )
    };
    let mut fields: HashMap<i64, BTreeMap<String, String>> = HashMap::new();
    let mut field_rows = rows(&db, &field_sql("fieldsCombined"), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, rusqlite::types::Value>(2)?,
        ))
    });
    if field_rows.is_empty() {
        field_rows = rows(&db, &field_sql("fields"), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        });
    }
    for (item, name, value) in field_rows {
        let text = match value {
            rusqlite::types::Value::Text(t) => t,
            rusqlite::types::Value::Integer(n) => n.to_string(),
            rusqlite::types::Value::Real(n) => n.to_string(),
            _ => continue,
        };
        fields.entry(item).or_default().insert(name, text);
    }

    let mut creators: HashMap<i64, Vec<(String, String)>> = HashMap::new();
    for (item, first, last, mode, role) in rows(
        &db,
        "SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, t.creatorType FROM itemCreators ic JOIN creators c USING (creatorID) JOIN creatorTypes t USING (creatorTypeID) ORDER BY ic.itemID, ic.orderIndex",
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, String>(4)?)),
    ) {
        let last = last.unwrap_or_default();
        let first = first.unwrap_or_default();
        let name = if mode == Some(1) || first.is_empty() {
            last
        } else {
            format!("{last}, {first}")
        };
        creators.entry(item).or_default().push((role, name));
    }

    let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
    for (item, name) in rows(
        &db,
        "SELECT it.itemID, t.name FROM itemTags it JOIN tags t USING (tagID)",
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    ) {
        tags.entry(item).or_default().push(name);
    }

    let mut membership: HashMap<i64, Vec<String>> = HashMap::new();
    for (item, collection) in rows(
        &db,
        "SELECT itemID, collectionID FROM collectionItems ORDER BY collectionID, orderIndex",
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    ) {
        let id = format!("c{collection}");
        if live_collections.contains(&id) {
            membership.entry(item).or_default().push(id);
        }
    }

    // Highlights belong to the PDF they were made on.
    let mut annotations: HashMap<i64, Vec<Annotation>> = HashMap::new();
    let mut skipped_annotations = 0usize;
    for (id, parent, kind, text, comment, color, position, key, added) in rows(
        &db,
        "SELECT a.itemID, a.parentItemID, a.type, a.text, a.comment, a.color, a.position, i.key, i.dateAdded FROM itemAnnotations a JOIN items i USING (itemID) ORDER BY a.sortIndex",
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        },
    ) {
        if deleted.contains(&id) {
            continue;
        }
        let kind = match kind {
            1 => "highlight",
            5 => "underline",
            2 => "note",
            _ => {
                skipped_annotations += 1;
                continue;
            }
        };
        let position: serde_json::Value = position
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or_default();
        let Some(page) = position["pageIndex"].as_u64() else {
            skipped_annotations += 1;
            continue;
        };
        let rects = position["rects"]
            .as_array()
            .map(|rects| {
                rects
                    .iter()
                    .filter_map(|r| {
                        let n: Vec<f64> = r.as_array()?.iter().filter_map(|v| v.as_f64()).collect();
                        (n.len() == 4).then(|| [n[0], n[1], n[2], n[3]])
                    })
                    .collect()
            })
            .unwrap_or_default();
        annotations.entry(parent).or_default().push(Annotation {
            id: format!("zotero:{key}"),
            kind: kind.into(),
            page: page as u32,
            rects,
            text: text.unwrap_or_default(),
            comment: comment.unwrap_or_default(),
            color: color.unwrap_or_else(|| "#ffd400".into()),
            created_at: added,
        });
    }
    if skipped_annotations > 0 {
        catalog.warnings.push(format!(
            "{skipped_annotations} 条图片或手绘批注没有导入，只导入高亮、下划线和便签。"
        ));
    }

    // Attachments: the PDF's place on disk and the item it belongs to.
    let mut attachments: HashMap<i64, Vec<(i64, Option<PathBuf>, String)>> = HashMap::new();
    let mut standalone_pdfs = vec![];
    for (id, parent, link, content, path, key) in rows(
        &db,
        "SELECT a.itemID, a.parentItemID, a.linkMode, a.contentType, a.path, i.key FROM itemAttachments a JOIN items i USING (itemID)",
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
            ))
        },
    ) {
        let path = path.unwrap_or_default();
        let pdf = content.as_deref() == Some("application/pdf")
            || path.to_lowercase().ends_with(".pdf");
        // Linked URLs have no file.
        if deleted.contains(&id) || !pdf || link == 3 {
            continue;
        }
        let file = if let Some(name) = path.strip_prefix("storage:") {
            Some(dir.join("storage").join(&key).join(name))
        } else if let Some(rest) = path.strip_prefix("attachments:") {
            base.as_ref().map(|base| base.join(rest))
        } else if !path.is_empty() {
            Some(PathBuf::from(&path))
        } else {
            None
        };
        let label = file
            .as_ref()
            .and_then(|f| f.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| if path.is_empty() { key.clone() } else { path.clone() });
        match parent {
            Some(parent) => attachments.entry(parent).or_default().push((id, file, label)),
            None => standalone_pdfs.push((id, file, label)),
        }
    }

    let mut notes: HashMap<i64, Vec<String>> = HashMap::new();
    let mut standalone_notes = vec![];
    for (id, parent, note) in rows(
        &db,
        "SELECT itemID, parentItemID, note FROM itemNotes",
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    ) {
        let markdown = html::to_markdown(&note.unwrap_or_default());
        if deleted.contains(&id) || markdown.is_empty() {
            continue;
        }
        match parent {
            Some(parent) => notes.entry(parent).or_default().push(markdown),
            None => standalone_notes.push((id, markdown)),
        }
    }

    let to_attachment = |(id, file, label): &(i64, Option<PathBuf>, String),
                         item: &mut Item,
                         annotations: &mut HashMap<i64, Vec<Annotation>>| {
        match file {
            Some(path) if path.is_file() => item.pdfs.push(Attachment {
                path: path.clone(),
                name: label.clone(),
                annotations: annotations.remove(id).unwrap_or_default(),
            }),
            _ => item.missing.push(label.clone()),
        }
    };

    let item_collections = |id: i64, library: i64, membership: &HashMap<i64, Vec<String>>| {
        let mut list = membership.get(&id).cloned().unwrap_or_default();
        if list.is_empty() && groups.contains_key(&library) {
            list.push(format!("lib:{library}"));
        }
        list
    };

    for (id, library, item_type, added) in rows(
        &db,
        "SELECT i.itemID, i.libraryID, t.typeName, i.dateAdded FROM items i JOIN itemTypes t USING (itemTypeID) ORDER BY i.dateAdded",
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        },
    ) {
        if deleted.contains(&id) || feeds.contains(&library) {
            continue;
        }
        let empty = BTreeMap::new();
        let f = fields.get(&id).unwrap_or(&empty);
        let get = |names: &[&str]| {
            names
                .iter()
                .find_map(|n| f.get(*n).filter(|v| !v.trim().is_empty()).cloned())
        };
        match item_type.as_str() {
            "note" => {
                if let Some(position) = standalone_notes.iter().position(|(n, _)| *n == id) {
                    let (_, markdown) = standalone_notes.remove(position);
                    catalog.items.push(Item {
                        reference: Reference {
                            title: html::title(&markdown),
                            ..Default::default()
                        },
                        collections: item_collections(id, library, &membership),
                        notes: vec![markdown],
                        standalone: true,
                        ..Default::default()
                    });
                }
                continue;
            }
            "annotation" => continue,
            "attachment" => {
                // A PDF with no parent entry is an entry of its own.
                let Some(position) = standalone_pdfs.iter().position(|(n, _, _)| *n == id) else {
                    continue;
                };
                let attachment = standalone_pdfs.remove(position);
                let title = get(&["title"]).unwrap_or_else(|| {
                    attachment.2.trim_end_matches(".pdf").trim_end_matches(".PDF").to_string()
                });
                let mut item = Item {
                    reference: Reference {
                        kind: "misc".into(),
                        title,
                        year: added.as_deref().and_then(year_of),
                        ..Default::default()
                    },
                    collections: item_collections(id, library, &membership),
                    ..Default::default()
                };
                to_attachment(&attachment, &mut item, &mut annotations);
                catalog.items.push(item);
                continue;
            }
            _ => {}
        }
        let people = creators.get(&id).cloned().unwrap_or_default();
        let mut authors: Vec<String> = people
            .iter()
            .filter(|(role, _)| role == "author")
            .map(|(_, name)| name.clone())
            .collect();
        if authors.is_empty() {
            authors = people.into_iter().map(|(_, name)| name).collect();
        }
        let extra = get(&["extra"]).unwrap_or_default();
        let mut reference = Reference {
            kind: kind(&item_type).into(),
            key: String::new(),
            title: get(&["title", "caseName", "subject", "nameOfAct"]).unwrap_or_default(),
            authors,
            year: get(&["date"]).and_then(|d| year_of(&d)),
            venue: get(&[
                "publicationTitle",
                "proceedingsTitle",
                "conferenceName",
                "bookTitle",
                "websiteTitle",
                "university",
                "institution",
                "repository",
                "publisher",
                "blogTitle",
            ]),
            doi: get(&["DOI"]).and_then(|d| clean_doi(&d)).or_else(|| {
                extra
                    .lines()
                    .find(|l| l.to_ascii_uppercase().starts_with("DOI:"))
                    .and_then(clean_doi)
            }),
            url: get(&["url"]),
            abstract_text: get(&["abstractNote"]),
            tags: tags.remove(&id).unwrap_or_default(),
            fields: BTreeMap::new(),
        };
        for (from, to) in [
            ("volume", "volume"),
            ("issue", "number"),
            ("pages", "pages"),
            ("publisher", "publisher"),
            ("place", "address"),
            ("edition", "edition"),
            ("series", "series"),
            ("ISBN", "isbn"),
            ("ISSN", "issn"),
        ] {
            if let Some(value) = get(&[from]) {
                reference.fields.insert(to.into(), value);
            }
        }
        let archive = get(&["archiveID"]).unwrap_or_default();
        if let Some(id) = archive
            .strip_prefix("arXiv:")
            .or_else(|| extra.lines().find_map(|l| l.trim().strip_prefix("arXiv:")))
        {
            reference.fields.insert("eprint".into(), id.trim().into());
            reference.fields.insert("archiveprefix".into(), "arXiv".into());
        }
        let mut item = Item {
            reference,
            collections: item_collections(id, library, &membership),
            notes: notes.remove(&id).unwrap_or_default(),
            ..Default::default()
        };
        for attachment in attachments.remove(&id).unwrap_or_default() {
            to_attachment(&attachment, &mut item, &mut annotations);
        }
        catalog.items.push(item);
    }
    catalog.assign_keys();
    Ok(Snapshot {
        catalog,
        from_backup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parts of Zotero's schema the reader touches, with one of everything.
    fn library(dir: &Path) {
        let db = Connection::open(dir.join("zotero.sqlite")).unwrap();
        db.execute_batch(
            r#"
CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
CREATE TABLE groups (groupID INT, libraryID INT, name TEXT);
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT, libraryID INT, key TEXT);
CREATE TABLE deletedItems (itemID INT);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT);
CREATE TABLE deletedCollections (collectionID INT);
CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);
CREATE TABLE fieldsCombined (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE itemTags (itemID INT, tagID INT, type INT);
CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, path TEXT);
CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, position TEXT);
INSERT INTO libraries VALUES (1, 'user'), (2, 'group'), (3, 'feed');
INSERT INTO groups VALUES (99, 2, 'Lab');
INSERT INTO itemTypes VALUES (1, 'annotation'), (3, 'attachment'), (28, 'note'), (5, 'journalArticle'), (6, 'preprint');
INSERT INTO collections VALUES (10, 'Robots', NULL, 1), (11, 'Grasping', 10, 1), (12, 'Gone', NULL, 1), (20, 'Shared', NULL, 2);
INSERT INTO deletedCollections VALUES (12);
INSERT INTO items VALUES
 (1, 5, '2024-01-01 10:00:00', 1, 'PAPER001'),
 (2, 3, '2024-01-01 10:00:00', 1, 'ATTACH01'),
 (3, 28, '2024-01-01 10:00:00', 1, 'NOTE0001'),
 (4, 1, '2024-01-02 10:00:00', 1, 'ANNOT001'),
 (5, 6, '2024-02-01 10:00:00', 1, 'TRASHED1'),
 (6, 28, '2024-02-02 10:00:00', 1, 'LOOSE001'),
 (7, 6, '2024-02-03 10:00:00', 2, 'GROUPIT1'),
 (8, 6, '2024-02-04 10:00:00', 3, 'FEEDITEM'),
 (9, 3, '2024-02-05 10:00:00', 1, 'ALONEPDF');
INSERT INTO deletedItems VALUES (5);
INSERT INTO collectionItems VALUES (11, 1, 0), (10, 1, 1), (12, 6, 0);
INSERT INTO fieldsCombined VALUES (1, 'title'), (2, 'date'), (3, 'publicationTitle'), (4, 'DOI'), (5, 'abstractNote'), (6, 'volume'), (7, 'extra');
INSERT INTO itemDataValues VALUES (1, 'Learning to Grasp'), (2, '2023-05-02 2023-05-02'), (3, 'Science Robotics'), (4, '10.1126/scirobotics.abc123'), (5, 'We grasp.'), (6, 8), (7, 'Group paper'), (8, 'arXiv: 2401.00001');
INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2), (1, 3, 3), (1, 4, 4), (1, 5, 5), (1, 6, 6), (7, 1, 7), (7, 7, 8);
INSERT INTO creators VALUES (1, 'Ada', 'Lovelace', 0), (2, NULL, 'OpenAI', 1);
INSERT INTO creatorTypes VALUES (1, 'author'), (2, 'editor');
INSERT INTO itemCreators VALUES (1, 1, 1, 0), (1, 2, 1, 1);
INSERT INTO tags VALUES (1, 'grasping');
INSERT INTO itemTags VALUES (1, 1, 0);
INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:grasp.pdf'), (9, NULL, 2, 'application/pdf', NULL);
INSERT INTO itemNotes VALUES (3, 1, '<p>Key <b>idea</b></p>', 'Key idea'), (6, NULL, '<h1>Reading list</h1><p>todo</p>', 'Reading list');
INSERT INTO itemAnnotations VALUES (4, 2, 1, 'grasp everything', 'nice', '#ffd400', '3', '00002|000100|00200', '{"pageIndex":2,"rects":[[10,20,110,32]]}');
"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("storage/ATTACH01")).unwrap();
        std::fs::write(dir.join("storage/ATTACH01/grasp.pdf"), b"%PDF-1.5").unwrap();
    }

    #[test]
    fn reads_items_collections_pdfs_notes_and_highlights() {
        let dir = tempfile::tempdir().unwrap();
        library(dir.path());
        let snapshot = read(dir.path(), &dir.path().join("scratch")).unwrap();
        assert!(!snapshot.from_backup);
        let catalog = snapshot.catalog;
        let names: Vec<_> = catalog
            .collections
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, vec!["Lab", "Grasping", "Robots", "Shared"]);
        assert_eq!(catalog.collections[1].parent.as_deref(), Some("c10"));
        assert_eq!(catalog.collections[3].parent.as_deref(), Some("lib:2"));

        let paper = &catalog.items[0];
        assert_eq!(paper.reference.title, "Learning to Grasp");
        assert_eq!(paper.reference.kind, "article");
        assert_eq!(paper.reference.authors, vec!["Lovelace, Ada", "OpenAI"]);
        assert_eq!(paper.reference.year.as_deref(), Some("2023"));
        assert_eq!(paper.reference.venue.as_deref(), Some("Science Robotics"));
        assert_eq!(
            paper.reference.doi.as_deref(),
            Some("10.1126/scirobotics.abc123")
        );
        assert_eq!(paper.reference.fields["volume"], "8");
        assert_eq!(paper.reference.tags, vec!["grasping"]);
        assert_eq!(paper.reference.key, "lovelace2023learning");
        assert_eq!(paper.collections, vec!["c10", "c11"]);
        assert_eq!(paper.notes, vec!["Key **idea**"]);
        assert_eq!(paper.pdfs.len(), 1);
        let highlight = &paper.pdfs[0].annotations[0];
        assert_eq!(highlight.id, "zotero:ANNOT001");
        assert_eq!(highlight.page, 2);
        assert_eq!(highlight.rects, vec![[10.0, 20.0, 110.0, 32.0]]);
        assert_eq!(highlight.comment, "nice");

        // The trashed item and the feed item are left out; the loose note's
        // collection was deleted, so it is unfiled.
        let titles: Vec<_> = catalog
            .items
            .iter()
            .map(|i| i.reference.title.as_str())
            .collect();
        assert_eq!(
            titles,
            vec![
                "Learning to Grasp",
                "Reading list",
                "Group paper",
                "ALONEPDF"
            ]
        );
        assert!(catalog.items[1].standalone);
        assert!(catalog.items[1].collections.is_empty());
        let group = &catalog.items[2];
        assert_eq!(group.collections, vec!["lib:2"]);
        assert_eq!(group.reference.fields["eprint"], "2401.00001");
        // A linked PDF with no path is listed as missing rather than dropped.
        assert_eq!(catalog.items[3].missing.len(), 1);
    }

    #[test]
    fn reads_the_custom_data_folder_from_preferences() {
        let text = "user_pref(\"extensions.zotero.dataDir\", \"D:\\\\Research\\\\Zotero\");\nuser_pref(\"x\", 1);";
        assert_eq!(
            preference(text, "extensions.zotero.dataDir").as_deref(),
            Some(r"D:\Research\Zotero")
        );
    }
}

/// Reads a real Zotero folder: `SCIENTIFY_ZOTERO_DIR=… cargo test -- --ignored live_zotero`.
#[cfg(test)]
#[test]
#[ignore]
fn live_zotero() {
    let dir = std::env::var_os("SCIENTIFY_ZOTERO_DIR")
        .map(PathBuf::from)
        .expect("SCIENTIFY_ZOTERO_DIR");
    let scratch = tempfile::tempdir().unwrap();
    let snapshot = read(&dir, scratch.path()).unwrap();
    let c = &snapshot.catalog;
    println!(
        "backup={} items={} pdfs={} missing={} notes={} highlights={} collections={} warnings={:?}",
        snapshot.from_backup,
        c.items.len(),
        c.items.iter().map(|i| i.pdfs.len()).sum::<usize>(),
        c.items.iter().map(|i| i.missing.len()).sum::<usize>(),
        c.items.iter().map(|i| i.notes.len()).sum::<usize>(),
        c.items
            .iter()
            .flat_map(|i| &i.pdfs)
            .map(|p| p.annotations.len())
            .sum::<usize>(),
        c.collections.len(),
        c.warnings
    );
    for item in c.items.iter().take(3) {
        println!(
            "{} | {:?} | {:?} | {}",
            item.reference.key, item.reference.year, item.reference.venue, item.reference.title
        );
    }
}
