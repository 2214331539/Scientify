//! Bringing a reference library from Zotero, BibTeX or RIS into a literature folder.
//! Each reader produces one [`Catalog`]; the app copies its PDFs and writes the
//! records, notes and a `references.bib` beside them.
pub mod bibtex;
pub mod html;
pub mod ris;
pub mod zotero;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

/// What a paper is, as a reference manager knows it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// BibTeX entry type: article, inproceedings, book, misc …
    #[serde(default)]
    pub kind: String,
    /// Citation key.
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    /// "Last, First", or one name for an institution.
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    /// Journal, proceedings, publisher or repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Other fields kept for citing: volume, pages, publisher …
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

/// A highlight, underline or sticky note on a PDF page.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    /// `highlight`, `underline` or `note`.
    pub kind: String,
    /// Zero-based page index.
    pub page: u32,
    /// PDF user-space rectangles `[x1, y1, x2, y2]`, origin at the bottom left.
    #[serde(default)]
    pub rects: Vec<[f64; 4]>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// A PDF that belongs to an entry, with the highlights made on it.
#[derive(Clone, Debug, Default)]
pub struct Attachment {
    pub path: PathBuf,
    pub name: String,
    pub annotations: Vec<Annotation>,
}

/// One entry to bring over.
#[derive(Clone, Debug, Default)]
pub struct Item {
    pub reference: Reference,
    /// Collection ids, in the order the source lists them.
    pub collections: Vec<String>,
    pub pdfs: Vec<Attachment>,
    /// PDFs the source lists but that are not on this disk.
    pub missing: Vec<String>,
    /// Notes in Markdown.
    pub notes: Vec<String>,
    /// A note with no paper of its own (Zotero standalone notes).
    pub standalone: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub items: Vec<Item>,
    pub collections: Vec<Collection>,
    pub warnings: Vec<String>,
}

impl Catalog {
    /// Gives every entry a citation key that is unique in this catalog.
    pub fn assign_keys(&mut self) {
        let mut used = HashSet::new();
        for item in &mut self.items {
            if item.standalone {
                continue;
            }
            let base = if item.reference.key.trim().is_empty() {
                citation_key(&item.reference)
            } else {
                item.reference.key.trim().to_string()
            };
            let mut key = base.clone();
            let mut suffix = b'a';
            while !used.insert(key.to_ascii_lowercase()) {
                key = format!("{base}{}", suffix as char);
                suffix = suffix.saturating_add(1);
            }
            item.reference.key = key;
        }
    }
}

fn ascii_word(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// `vaswani2017attention`: first author, year and first title word, as most tools do.
pub fn citation_key(reference: &Reference) -> String {
    let author = reference
        .authors
        .first()
        .map(|name| name.split(',').next().unwrap_or(name).trim())
        .and_then(|last| last.split_whitespace().last())
        .map(ascii_word)
        .unwrap_or_default();
    let skip = [
        "a", "an", "the", "on", "of", "for", "in", "to", "and", "with",
    ];
    let word = reference
        .title
        .split_whitespace()
        .map(ascii_word)
        .find(|w| !w.is_empty() && !skip.contains(&w.as_str()))
        .unwrap_or_default();
    let key = format!(
        "{}{}{}",
        author,
        reference.year.as_deref().unwrap_or(""),
        word
    );
    if key.is_empty() {
        "ref".into()
    } else {
        key
    }
}

/// The first four-digit year in a date such as `2026-11-09 2026-11-09` or `March 2019`.
pub fn year_of(date: &str) -> Option<String> {
    let digits: Vec<char> = date.chars().collect();
    digits.windows(4).find_map(|w| {
        (w.iter().all(|c| c.is_ascii_digit()) && matches!(w[0], '1' | '2'))
            .then(|| w.iter().collect())
    })
}

/// `10.1000/xyz` from a bare DOI, a doi.org link or a `DOI: …` line.
pub fn clean_doi(text: &str) -> Option<String> {
    let start = text.find("10.")?;
    let doi: String = text[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ',' && *c != ';')
        .collect();
    (doi.contains('/') && doi.len() > 6).then(|| doi.trim_end_matches('.').to_string())
}

fn bib_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' | '%' | '$' | '#' | '_' => {
                out.push('\\');
                out.push(c);
            }
            '{' | '}' => {}
            _ => out.push(c),
        }
    }
    out
}

/// One BibTeX entry; `file` is the PDF's path inside the literature folder.
pub fn to_bibtex(reference: &Reference, file: Option<&str>) -> String {
    let kind = if reference.kind.is_empty() {
        "misc"
    } else {
        &reference.kind
    };
    let mut fields: Vec<(String, String)> = vec![];
    if !reference.title.is_empty() {
        fields.push((
            "title".into(),
            format!("{{{}}}", bib_escape(&reference.title)),
        ));
    }
    if !reference.authors.is_empty() {
        let names: Vec<String> = reference
            .authors
            .iter()
            .map(|name| {
                if name.contains(',') {
                    bib_escape(name)
                } else {
                    format!("{{{}}}", bib_escape(name))
                }
            })
            .collect();
        fields.push(("author".into(), names.join(" and ")));
    }
    if let Some(year) = &reference.year {
        fields.push(("year".into(), year.clone()));
    }
    if let Some(venue) = &reference.venue {
        let name = match kind {
            "article" => "journal",
            "inproceedings" | "incollection" => "booktitle",
            "phdthesis" | "mastersthesis" => "school",
            "techreport" => "institution",
            "book" => "publisher",
            _ => "howpublished",
        };
        if !reference.fields.contains_key(name) {
            fields.push((name.into(), bib_escape(venue)));
        }
    }
    for (name, value) in &reference.fields {
        fields.push((name.clone(), bib_escape(value)));
    }
    if let Some(doi) = &reference.doi {
        fields.push(("doi".into(), doi.clone()));
    }
    if let Some(url) = &reference.url {
        fields.push(("url".into(), url.clone()));
    }
    if !reference.tags.is_empty() {
        fields.push(("keywords".into(), bib_escape(&reference.tags.join(", "))));
    }
    if let Some(text) = &reference.abstract_text {
        fields.push(("abstract".into(), bib_escape(text)));
    }
    if let Some(file) = file {
        fields.push(("file".into(), file.replace(':', "\\:")));
    }
    let body: Vec<String> = fields
        .into_iter()
        .map(|(name, value)| format!("  {name} = {{{value}}}"))
        .collect();
    format!("@{kind}{{{},\n{}\n}}\n", reference.key, body.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_years_and_dois_come_out_the_way_tools_write_them() {
        let mut reference = Reference {
            title: "Attention Is All You Need".into(),
            authors: vec!["Vaswani, Ashish".into()],
            year: year_of("2017-06-12 2017-06-12"),
            ..Default::default()
        };
        assert_eq!(citation_key(&reference), "vaswani2017attention");
        assert_eq!(year_of("Spring 1999"), Some("1999".into()));
        assert_eq!(
            clean_doi("https://doi.org/10.1145/3292500.3330701."),
            Some("10.1145/3292500.3330701".into())
        );
        reference.key = "vaswani2017attention".into();
        reference.kind = "inproceedings".into();
        reference.venue = Some("NeurIPS & co".into());
        let bib = to_bibtex(&reference, Some("Zotero/a.pdf"));
        assert!(bib.starts_with("@inproceedings{vaswani2017attention,"));
        assert!(bib.contains("booktitle = {NeurIPS \\& co}"));
        assert!(bib.contains("file = {Zotero/a.pdf}"));
    }

    #[test]
    fn duplicate_keys_get_letters() {
        let reference = Reference {
            title: "Graph networks".into(),
            authors: vec!["Li, Wei".into()],
            year: Some("2020".into()),
            ..Default::default()
        };
        let mut catalog = Catalog {
            items: vec![
                Item {
                    reference: reference.clone(),
                    ..Default::default()
                },
                Item {
                    reference,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        catalog.assign_keys();
        assert_eq!(catalog.items[0].reference.key, "li2020graph");
        assert_eq!(catalog.items[1].reference.key, "li2020grapha");
    }
}
