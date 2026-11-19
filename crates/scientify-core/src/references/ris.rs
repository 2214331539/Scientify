//! RIS files (`TY  - JOUR` … `ER  -`), as EndNote, Mendeley, Zotero and publishers write them.
use super::{clean_doi, year_of, Attachment, Catalog, Item, Reference};
use std::path::Path;

fn kind(ty: &str) -> &'static str {
    match ty {
        "JOUR" | "JFULL" | "MGZN" | "NEWS" | "EJOUR" => "article",
        "CONF" | "CPAPER" => "inproceedings",
        "BOOK" | "EBOOK" => "book",
        "CHAP" | "ECHAP" => "incollection",
        "THES" => "phdthesis",
        "RPRT" => "techreport",
        "UNPB" | "MANSCPT" => "unpublished",
        _ => "misc",
    }
}

/// `file:///C:/a%20b.pdf` → `C:/a b.pdf`.
fn file_url(text: &str) -> String {
    let Some(rest) = text.strip_prefix("file://") else {
        return text.to_string();
    };
    let rest = rest
        .strip_prefix('/')
        .filter(|r| r.get(1..2) == Some(":"))
        .unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(n) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Reads RIS text; relative PDF paths resolve against `base`.
pub fn parse(text: &str, base: &Path) -> Catalog {
    let mut catalog = Catalog::default();
    let mut record: Vec<(String, String)> = vec![];
    let finish = |record: &mut Vec<(String, String)>, catalog: &mut Catalog| {
        if record.is_empty() {
            return;
        }
        let get = |tags: &[&str]| {
            tags.iter().find_map(|tag| {
                record
                    .iter()
                    .find(|(t, v)| t == tag && !v.trim().is_empty())
                    .map(|(_, v)| v.trim().to_string())
            })
        };
        let all = |tags: &[&str]| -> Vec<String> {
            record
                .iter()
                .filter(|(t, v)| tags.contains(&t.as_str()) && !v.trim().is_empty())
                .map(|(_, v)| v.trim().to_string())
                .collect()
        };
        let mut reference = Reference {
            kind: kind(&get(&["TY"]).unwrap_or_default()).to_string(),
            key: get(&["ID"]).unwrap_or_default(),
            title: get(&["TI", "T1", "CT", "BT"]).unwrap_or_default(),
            authors: all(&["AU", "A1"]),
            year: get(&["PY", "Y1", "DA", "Y2"]).and_then(|d| year_of(&d)),
            venue: get(&["T2", "JO", "JF", "JA", "J2", "PB"]),
            doi: get(&["DO"]).and_then(|d| clean_doi(&d)),
            url: all(&["UR"]).into_iter().find(|u| u.starts_with("http")),
            abstract_text: get(&["AB", "N2"]),
            tags: all(&["KW"]),
            ..Default::default()
        };
        if reference.authors.is_empty() {
            reference.authors = all(&["A2", "ED"]);
        }
        for (tag, field) in [
            ("VL", "volume"),
            ("IS", "number"),
            ("PB", "publisher"),
            ("CY", "address"),
            ("SN", "issn"),
            ("ET", "edition"),
        ] {
            if let Some(value) = get(&[tag]) {
                reference.fields.insert(field.into(), value);
            }
        }
        match (get(&["SP"]), get(&["EP"])) {
            (Some(start), Some(end)) => {
                reference
                    .fields
                    .insert("pages".into(), format!("{start}–{end}"));
            }
            (Some(start), None) => {
                reference.fields.insert("pages".into(), start);
            }
            _ => {}
        }
        let mut item = Item {
            reference,
            notes: all(&["N1"]),
            ..Default::default()
        };
        for link in all(&["L1", "L4", "UR"]) {
            if !link.to_lowercase().ends_with(".pdf") || link.starts_with("http") {
                continue;
            }
            // EndNote's `internal-pdf://` points into its own library folder.
            if link.starts_with("internal-pdf://") {
                item.missing.push(link);
                continue;
            }
            let path = file_url(&link);
            let full = if Path::new(&path).is_absolute() {
                Path::new(&path).to_path_buf()
            } else {
                base.join(&path)
            };
            if full.is_file() {
                item.pdfs.push(Attachment {
                    name: full
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "paper.pdf".into()),
                    path: full,
                    annotations: vec![],
                });
            } else {
                item.missing.push(path);
            }
        }
        catalog.items.push(item);
        record.clear();
    };
    for line in text.lines() {
        let line = line.trim_end_matches('\r').trim_start_matches('\u{feff}');
        let bytes = line.as_bytes();
        let tagged = bytes.len() >= 5
            && bytes[0].is_ascii_uppercase()
            && bytes[1].is_ascii_alphanumeric()
            && line[2..].trim_start().starts_with('-');
        if tagged {
            let tag = line[..2].to_string();
            let value = line[2..].trim_start()[1..].trim().to_string();
            if tag == "ER" {
                finish(&mut record, &mut catalog);
            } else {
                record.push((tag, value));
            }
        } else if let Some(last) = record.last_mut() {
            if !line.trim().is_empty() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        }
    }
    finish(&mut record, &mut catalog);
    if catalog.items.is_empty() {
        catalog.warnings.push("文件里没有找到 RIS 条目。".into());
    }
    catalog.assign_keys();
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_records_with_continuations_and_local_pdfs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("files/3")).unwrap();
        std::fs::write(dir.path().join("files/3/a b.pdf"), b"%PDF-1.7").unwrap();
        let text = "\u{feff}TY  - JOUR\r\nTI  - Deep learning\r\nAU  - LeCun, Yann\r\nAU  - Bengio, Yoshua\r\nPY  - 2015///\r\nT2  - Nature\r\nVL  - 521\r\nSP  - 436\r\nEP  - 444\r\nDO  - 10.1038/nature14539\r\nAB  - First line\r\n  continues here\r\nKW  - neural networks\r\nL1  - files/3/a b.pdf\r\nL1  - internal-pdf://123/x.pdf\r\nER  - \r\n\r\nTY  - CONF\r\nT1  - Second\r\nER  -\r\n";
        let catalog = parse(text, dir.path());
        assert_eq!(catalog.items.len(), 2);
        let first = &catalog.items[0];
        assert_eq!(first.reference.kind, "article");
        assert_eq!(first.reference.title, "Deep learning");
        assert_eq!(
            first.reference.authors,
            vec!["LeCun, Yann", "Bengio, Yoshua"]
        );
        assert_eq!(first.reference.year.as_deref(), Some("2015"));
        assert_eq!(first.reference.venue.as_deref(), Some("Nature"));
        assert_eq!(first.reference.fields["pages"], "436–444");
        assert_eq!(
            first.reference.abstract_text.as_deref(),
            Some("First line continues here")
        );
        assert_eq!(first.reference.key, "lecun2015deep");
        assert_eq!(first.pdfs.len(), 1);
        assert_eq!(first.missing, vec!["internal-pdf://123/x.pdf"]);
        assert_eq!(catalog.items[1].reference.kind, "inproceedings");
        assert_eq!(file_url("file:///C:/a%20b.pdf"), "C:/a b.pdf");
    }
}
