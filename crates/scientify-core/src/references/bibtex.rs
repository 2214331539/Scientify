//! BibTeX and BibLaTeX files, as Zotero, Mendeley, JabRef and Google Scholar write them.
use super::{clean_doi, year_of, Attachment, Catalog, Item, Reference};
use std::collections::BTreeMap;
use std::path::Path;

/// Fields copied into [`Reference::fields`] for citing.
const KEPT: [&str; 14] = [
    "volume",
    "number",
    "pages",
    "publisher",
    "address",
    "edition",
    "series",
    "isbn",
    "issn",
    "eprint",
    "archiveprefix",
    "primaryclass",
    "month",
    "organization",
];

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
    macros: BTreeMap<String, String>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }
    fn skip_space(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            self.at += 1;
        }
    }
    fn word(&mut self) -> String {
        let start = self.at;
        while self
            .peek()
            .is_some_and(|c| !c.is_ascii_whitespace() && !b"{}(),=#\"".contains(&c))
        {
            self.at += 1;
        }
        String::from_utf8_lossy(&self.text[start..self.at]).into_owned()
    }
    /// The inside of a `{…}` group, braces kept balanced; the cursor sits on `{`.
    fn braced(&mut self) -> String {
        let start = self.at + 1;
        let mut depth = 0usize;
        while let Some(c) = self.peek() {
            match c {
                b'\\' => self.at += 1,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let inside =
                            String::from_utf8_lossy(&self.text[start..self.at]).into_owned();
                        self.at += 1;
                        return inside;
                    }
                }
                _ => {}
            }
            self.at += 1;
        }
        String::from_utf8_lossy(&self.text[start.min(self.text.len())..]).into_owned()
    }
    fn quoted(&mut self) -> String {
        self.at += 1;
        let start = self.at;
        let mut depth = 0usize;
        while let Some(c) = self.peek() {
            match c {
                b'\\' => self.at += 1,
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                b'"' if depth == 0 => {
                    let inside = String::from_utf8_lossy(&self.text[start..self.at]).into_owned();
                    self.at += 1;
                    return inside;
                }
                _ => {}
            }
            self.at += 1;
        }
        String::from_utf8_lossy(&self.text[start.min(self.text.len())..]).into_owned()
    }
    /// A value: parts joined with `#`, each braced, quoted, a number or a macro.
    fn value(&mut self) -> String {
        let mut out = String::new();
        loop {
            self.skip_space();
            match self.peek() {
                Some(b'{') => out.push_str(&self.braced()),
                Some(b'"') => out.push_str(&self.quoted()),
                Some(_) => {
                    let word = self.word();
                    let lower = word.to_ascii_lowercase();
                    out.push_str(self.macros.get(&lower).map(String::as_str).unwrap_or(&word));
                }
                None => break,
            }
            self.skip_space();
            if self.peek() == Some(b'#') {
                self.at += 1;
            } else {
                break;
            }
        }
        out
    }
    /// Skips to the end of an entry whose body we do not read.
    fn skip_body(&mut self, close: u8) {
        if close == b'}' {
            self.braced();
        } else {
            let mut depth = 0usize;
            while let Some(c) = self.peek() {
                self.at += 1;
                match c {
                    b'(' => depth += 1,
                    b')' if depth <= 1 => return,
                    b')' => depth -= 1,
                    _ => {}
                }
            }
        }
    }
}

/// Entries with their raw field values, keyed by lower-case field name.
pub fn entries(text: &str) -> Vec<(String, String, BTreeMap<String, String>)> {
    let mut parser = Parser {
        text: text.as_bytes(),
        at: 0,
        macros: [
            "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        ]
        .iter()
        .enumerate()
        .map(|(n, m)| (m.to_string(), (n + 1).to_string()))
        .collect(),
    };
    let mut out = vec![];
    while parser.at < parser.text.len() {
        if parser.peek() != Some(b'@') {
            parser.at += 1;
            continue;
        }
        parser.at += 1;
        let kind = parser.word().to_ascii_lowercase();
        parser.skip_space();
        let close = match parser.peek() {
            Some(b'{') => b'}',
            Some(b'(') => b')',
            _ => continue,
        };
        if matches!(kind.as_str(), "comment" | "preamble") {
            parser.skip_body(close);
            continue;
        }
        parser.at += 1;
        if kind == "string" {
            parser.skip_space();
            let name = parser.word().to_ascii_lowercase();
            parser.skip_space();
            if parser.peek() == Some(b'=') {
                parser.at += 1;
                let value = parser.value();
                parser.macros.insert(name, value);
            }
            parser.skip_space();
            if parser.peek() == Some(close) {
                parser.at += 1;
            }
            continue;
        }
        parser.skip_space();
        let start = parser.at;
        while parser.peek().is_some_and(|c| c != b',' && c != close) {
            parser.at += 1;
        }
        let key = String::from_utf8_lossy(&parser.text[start..parser.at])
            .trim()
            .to_string();
        let mut fields = BTreeMap::new();
        loop {
            parser.skip_space();
            match parser.peek() {
                Some(b',') => parser.at += 1,
                Some(c) if c == close => {
                    parser.at += 1;
                    break;
                }
                None => break,
                Some(_) => {
                    let name = parser.word().to_ascii_lowercase();
                    parser.skip_space();
                    if parser.peek() != Some(b'=') {
                        // Not a field: step past it so a damaged entry cannot stall.
                        if name.is_empty() {
                            parser.at += 1;
                        }
                        continue;
                    }
                    parser.at += 1;
                    let value = parser.value();
                    if !name.is_empty() {
                        fields.insert(name, value);
                    }
                }
            }
        }
        out.push((kind, key, fields));
    }
    out
}

fn accent(mark: char, base: char) -> String {
    let table: &[(char, &str, &str)] = &[
        ('"', "aeiouyAEIOU", "äëïöüÿÄËÏÖÜ"),
        ('\'', "aeiouyncszAEIOUYNCSZ", "áéíóúýńćśźÁÉÍÓÚÝŃĆŚŹ"),
        ('`', "aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        ('^', "aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        ('~', "anoANO", "ãñõÃÑÕ"),
        ('c', "csCS", "çşÇŞ"),
        ('v', "cszrnetdCSZRNETD", "čšžřňěťďČŠŽŘŇĚŤĎ"),
        ('=', "aeiouAEIOU", "āēīōūĀĒĪŌŪ"),
        ('u', "agAG", "ăğĂĞ"),
        ('H', "ouOU", "őűŐŰ"),
        ('k', "aeAE", "ąęĄĘ"),
        ('.', "zZI", "żŻİ"),
        ('r', "auAU", "åůÅŮ"),
    ];
    for (m, from, to) in table {
        if *m == mark {
            if let Some(n) = from.chars().position(|c| c == base) {
                return to.chars().nth(n).unwrap().to_string();
            }
        }
    }
    base.to_string()
}

/// Readable text from a BibTeX value: accents, escapes and dashes resolved, braces dropped.
pub fn latex_text(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    // The first letter after an accent command, possibly inside braces.
    let next_letter = |i: &mut usize| -> Option<char> {
        while *i < chars.len() && (chars[*i] == '{' || chars[*i] == ' ') {
            *i += 1;
        }
        let c = chars.get(*i).copied();
        *i += 1;
        if chars.get(*i) == Some(&'}') {
            *i += 1;
        }
        c
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                i += 1;
                let Some(&n) = chars.get(i) else { break };
                if n.is_ascii_alphabetic() {
                    let start = i;
                    while i < chars.len() && chars[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let name: String = chars[start..i].iter().collect();
                    match name.as_str() {
                        "c" | "v" | "u" | "H" | "k" | "r" => {
                            if let Some(base) = next_letter(&mut i) {
                                out.push_str(&accent(name.chars().next().unwrap(), base));
                            }
                        }
                        "ss" => out.push('ß'),
                        "o" => out.push('ø'),
                        "O" => out.push('Ø'),
                        "aa" => out.push('å'),
                        "AA" => out.push('Å'),
                        "ae" => out.push('æ'),
                        "AE" => out.push('Æ'),
                        "oe" => out.push('œ'),
                        "l" => out.push('ł'),
                        "L" => out.push('Ł'),
                        "i" => out.push('i'),
                        "textendash" => out.push('–'),
                        "textemdash" => out.push('—'),
                        "ldots" | "dots" => out.push('…'),
                        _ => {}
                    }
                    // `\emph {x}`: the group's text stays, the space after a command goes.
                    while chars.get(i) == Some(&' ') && name.len() > 1 {
                        i += 1;
                    }
                } else {
                    i += 1;
                    match n {
                        '"' | '\'' | '`' | '^' | '~' | '=' | '.' => {
                            if let Some(base) = next_letter(&mut i) {
                                out.push_str(&accent(n, base));
                            }
                        }
                        '\\' => out.push(' '),
                        _ => out.push(n),
                    }
                }
            }
            '{' | '}' | '$' => i += 1,
            '~' => {
                out.push(' ');
                i += 1;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                if chars.get(i + 2) == Some(&'-') {
                    out.push('—');
                    i += 3;
                } else {
                    out.push('–');
                    i += 2;
                }
            }
            c if c.is_whitespace() => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out.trim().to_string()
}

/// Splits `A and B and {C and D Inc.}` at the top-level `and`s.
fn split_names(raw: &str) -> Vec<String> {
    let mut names = vec![];
    let mut depth = 0i32;
    let mut current = String::new();
    let words: Vec<&str> = raw.split_whitespace().collect();
    for word in words {
        if depth == 0 && word.eq_ignore_ascii_case("and") {
            names.push(std::mem::take(&mut current));
            continue;
        }
        depth += word.matches('{').count() as i32 - word.matches('}').count() as i32;
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    names.push(current);
    names
        .into_iter()
        .filter(|n| !n.trim().is_empty())
        .map(|name| {
            let name = name.trim();
            // `{World Health Organization}` is one name, not first and last.
            if name.starts_with('{') && name.ends_with('}') && !name[1..].contains('{') {
                return latex_text(name);
            }
            let text = latex_text(name);
            if text.contains(',') {
                return text;
            }
            match text.rsplit_once(' ') {
                Some((first, last)) => format!("{last}, {first}"),
                None => text,
            }
        })
        .collect()
}

/// PDF paths in a `file` field: Zotero `desc:C\:\\x.pdf:application/pdf`,
/// JabRef `:x.pdf:PDF` and Mendeley `:C$\backslash$:/x.pdf:pdf`, `;`-separated.
pub fn file_paths(raw: &str) -> Vec<String> {
    let text = raw.replace("$\\backslash$", "\\");
    let mut entries = vec![];
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // Escaped characters wait as placeholders until the fields are split.
            '\\' => match chars.peek() {
                Some(':') => {
                    current.push('\u{1}');
                    chars.next();
                }
                Some(';') => {
                    current.push('\u{2}');
                    chars.next();
                }
                Some('\\') => {
                    current.push('\\');
                    chars.next();
                }
                _ => current.push('\\'),
            },
            ';' => entries.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    entries.push(current);
    let mut paths = vec![];
    for entry in entries {
        let parts: Vec<String> = entry
            .split(':')
            .map(|p| p.replace('\u{1}', ":").replace('\u{2}', ";"))
            .collect();
        let candidate = match parts.len() {
            0 => None,
            1 => Some(parts[0].clone()),
            2 => parts
                .iter()
                .find(|p| p.to_lowercase().ends_with(".pdf"))
                .cloned(),
            // A Windows drive left unescaped: `:C:/x/y.pdf:PDF`.
            n if n >= 4 && parts[1].len() == 1 => Some(format!("{}:{}", parts[1], parts[2])),
            _ => Some(parts[1].clone()),
        };
        if let Some(path) = candidate.map(|p| p.trim().to_string()) {
            if path.to_lowercase().ends_with(".pdf") {
                paths.push(path);
            }
        }
    }
    paths
}

/// Turns raw BibTeX fields into a reference, PDFs found relative to `base`.
pub fn item(kind: &str, key: &str, fields: &BTreeMap<String, String>, base: &Path) -> Item {
    let text = |name: &str| {
        fields
            .get(name)
            .map(|v| latex_text(v))
            .filter(|v| !v.is_empty())
    };
    let mut reference = Reference {
        kind: kind.to_string(),
        key: key.to_string(),
        title: text("title").unwrap_or_default(),
        authors: fields
            .get("author")
            .or_else(|| fields.get("editor"))
            .map(|v| split_names(v))
            .unwrap_or_default(),
        year: text("year").or_else(|| text("date").and_then(|d| year_of(&d))),
        venue: [
            "journal",
            "journaltitle",
            "booktitle",
            "school",
            "institution",
            "howpublished",
            "publisher",
        ]
        .iter()
        .find_map(|name| text(name)),
        doi: fields.get("doi").and_then(|d| clean_doi(d)),
        url: text("url"),
        abstract_text: text("abstract"),
        tags: text("keywords")
            .map(|k| {
                k.split([',', ';'])
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        fields: BTreeMap::new(),
    };
    for name in KEPT {
        if let Some(value) = text(name) {
            reference.fields.insert(name.to_string(), value);
        }
    }
    let mut out = Item {
        reference,
        ..Default::default()
    };
    for path in fields
        .get("file")
        .map(|f| file_paths(f))
        .unwrap_or_default()
    {
        let path = path.strip_prefix("file://").unwrap_or(&path).to_string();
        let full = if Path::new(&path).is_absolute() {
            Path::new(&path).to_path_buf()
        } else {
            base.join(&path)
        };
        if full.is_file() {
            out.pdfs.push(Attachment {
                name: full
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "paper.pdf".into()),
                path: full,
                annotations: vec![],
            });
        } else {
            out.missing.push(path);
        }
    }
    for name in ["annote", "annotation", "note"] {
        if let Some(note) = text(name) {
            out.notes.push(note);
        }
    }
    out
}

/// Reads a `.bib` file's text; relative PDF paths resolve against `base`.
pub fn parse(text: &str, base: &Path) -> Catalog {
    let mut catalog = Catalog::default();
    for (kind, key, fields) in entries(text) {
        if fields.is_empty() {
            continue;
        }
        catalog.items.push(item(&kind, &key, &fields, base));
    }
    if catalog.items.is_empty() {
        catalog.warnings.push("文件里没有找到 BibTeX 条目。".into());
    }
    catalog.assign_keys();
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_entries_with_accents_macros_and_nested_braces() {
        let text = r#"
@string{nips = "Advances in Neural Information Processing Systems"}
@comment{ignored {entry}}
@InProceedings{vaswani2017,
  title     = {Attention Is {All} You Need},
  author    = {Vaswani, Ashish and Noam Shazeer and {Google Brain}},
  booktitle = nips # " 30",
  year      = 2017,
  pages     = {5998--6008},
  doi       = {https://doi.org/10.5555/3295222.3295349},
  keywords  = {transformer; attention},
}
@article(muller,
  title = "M{\"u}ller's \emph{Na\"ive} Study of {\c C}a\~{n}on",
  author = "J{\"o}rg M{\"u}ller",
  journaltitle = {Journal of Tests},
  date = {2019-03},
  file = {Full Text:C\:\\Papers\\muller.pdf:application/pdf},
)
"#;
        let catalog = parse(text, Path::new("/nowhere"));
        assert_eq!(catalog.items.len(), 2);
        let a = &catalog.items[0].reference;
        assert_eq!(a.kind, "inproceedings");
        assert_eq!(a.key, "vaswani2017");
        assert_eq!(a.title, "Attention Is All You Need");
        assert_eq!(
            a.authors,
            vec!["Vaswani, Ashish", "Shazeer, Noam", "Google Brain"]
        );
        assert_eq!(
            a.venue.as_deref(),
            Some("Advances in Neural Information Processing Systems 30")
        );
        assert_eq!(a.year.as_deref(), Some("2017"));
        assert_eq!(a.fields["pages"], "5998–6008");
        assert_eq!(a.doi.as_deref(), Some("10.5555/3295222.3295349"));
        assert_eq!(a.tags, vec!["transformer", "attention"]);
        let b = &catalog.items[1];
        assert_eq!(b.reference.title, "Müller's Naïve Study of Çañon");
        assert_eq!(b.reference.authors, vec!["Müller, Jörg"]);
        assert_eq!(b.reference.year.as_deref(), Some("2019"));
        assert_eq!(b.missing, vec![r"C:\Papers\muller.pdf"]);
    }

    #[test]
    fn finds_pdfs_in_the_file_field_formats_of_common_tools() {
        assert_eq!(
            file_paths(
                r"Full Text PDF:files/12/a.pdf:application/pdf;Snapshot:files/12/b.html:text/html"
            ),
            vec!["files/12/a.pdf"]
        );
        assert_eq!(file_paths(":papers/x.pdf:PDF"), vec!["papers/x.pdf"]);
        assert_eq!(
            file_paths(r":C$\backslash$:/Users/me/y.pdf:pdf"),
            vec!["C:/Users/me/y.pdf"]
        );
        assert_eq!(file_paths("/home/me/z.pdf"), vec!["/home/me/z.pdf"]);
    }

    #[test]
    fn copies_pdfs_that_exist_relative_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("files/1")).unwrap();
        std::fs::write(dir.path().join("files/1/p.pdf"), b"%PDF-1.4").unwrap();
        let catalog = parse(
            "@misc{k, title={T}, file={PDF:files/1/p.pdf:application/pdf}, annote={Read it}}",
            dir.path(),
        );
        let item = &catalog.items[0];
        assert_eq!(item.pdfs.len(), 1);
        assert_eq!(item.pdfs[0].name, "p.pdf");
        assert_eq!(item.notes, vec!["Read it"]);
    }
}
