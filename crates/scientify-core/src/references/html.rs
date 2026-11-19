//! Zotero notes are HTML; the literature folder keeps notes in Markdown.

fn entity(name: &str) -> Option<String> {
    let named = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "mdash" => "—",
        "ndash" => "–",
        "hellip" => "…",
        "laquo" => "«",
        "raquo" => "»",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.to_string());
    }
    let number = name.strip_prefix('#')?;
    let code = match number.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => number.parse().ok()?,
    };
    char::from_u32(code).map(String::from)
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[at..];
    let quote = rest.chars().next()?;
    let value = if quote == '"' || quote == '\'' {
        rest[1..].split(quote).next()?
    } else {
        rest.split([' ', '>']).next()?
    };
    Some(decode(value))
}

fn decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        match tail.find(';').filter(|end| *end <= 10) {
            Some(end) => match entity(&tail[..end]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &tail[end + 1..];
                }
                None => {
                    out.push('&');
                    rest = tail;
                }
            },
            None => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Markdown for a Zotero note: headings, paragraphs, lists, quotes, emphasis,
/// links and code; other markup is dropped and its text kept.
pub fn to_markdown(html: &str) -> String {
    // Each open blockquote collects its own text, prefixed with `> ` when it closes.
    let mut buffers = vec![String::new()];
    let mut lists: Vec<(bool, usize)> = vec![];
    let mut links: Vec<Option<String>> = vec![];
    let mut pre = 0usize;
    let mut rest = html;
    let push = |buffers: &mut Vec<String>, text: &str| buffers.last_mut().unwrap().push_str(text);
    let block = |buffers: &mut Vec<String>| {
        let out = buffers.last_mut().unwrap();
        let trimmed = out.trim_end_matches(' ').len();
        out.truncate(trimmed);
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push_str(if out.ends_with('\n') { "\n" } else { "\n\n" });
        }
    };
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            let text = decode(rest);
            push(&mut buffers, &if pre > 0 { text } else { collapse(&text) });
            break;
        };
        if open > 0 {
            let text = decode(&rest[..open]);
            push(&mut buffers, &if pre > 0 { text } else { collapse(&text) });
        }
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        match (name.as_str(), closing) {
            ("p" | "div", _) => block(&mut buffers),
            ("br", _) => push(&mut buffers, "\n"),
            ("h1" | "h2" | "h3" | "h4" | "h5" | "h6", false) => {
                block(&mut buffers);
                let level = name[1..].parse::<usize>().unwrap_or(1);
                push(&mut buffers, &format!("{} ", "#".repeat(level)));
            }
            ("h1" | "h2" | "h3" | "h4" | "h5" | "h6", true) => block(&mut buffers),
            // A nested list continues its parent item; only the outer list is its own block.
            ("ul" | "ol", false) => {
                if lists.is_empty() {
                    block(&mut buffers);
                }
                lists.push((name == "ol", 0));
            }
            ("ul" | "ol", true) => {
                lists.pop();
                if lists.is_empty() {
                    block(&mut buffers);
                }
            }
            ("li", false) => {
                let depth = lists.len().saturating_sub(1);
                let marker = match lists.last_mut() {
                    Some((true, n)) => {
                        *n += 1;
                        format!("{n}. ")
                    }
                    _ => "- ".to_string(),
                };
                let out = buffers.last_mut().unwrap();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&"  ".repeat(depth));
                out.push_str(&marker);
            }
            ("blockquote", false) => {
                block(&mut buffers);
                buffers.push(String::new());
            }
            ("blockquote", true) if buffers.len() > 1 => {
                let inner = buffers.pop().unwrap();
                let quoted: Vec<String> = inner
                    .trim()
                    .lines()
                    .map(|line| format!("> {line}").trim_end().to_string())
                    .collect();
                push(&mut buffers, &quoted.join("\n"));
                block(&mut buffers);
            }
            ("strong" | "b", _) => push(&mut buffers, "**"),
            ("em" | "i", _) => push(&mut buffers, "*"),
            ("code", _) if pre == 0 => push(&mut buffers, "`"),
            ("pre", false) => {
                block(&mut buffers);
                push(&mut buffers, "```\n");
                pre += 1;
            }
            ("pre", true) => {
                pre = pre.saturating_sub(1);
                push(&mut buffers, "\n```");
                block(&mut buffers);
            }
            ("a", false) => {
                let href = attribute(tag, "href");
                if href.is_some() {
                    push(&mut buffers, "[");
                }
                links.push(href);
            }
            ("a", true) => {
                if let Some(Some(href)) = links.pop() {
                    push(&mut buffers, &format!("]({href})"));
                }
            }
            _ => {}
        }
    }
    while buffers.len() > 1 {
        let inner = buffers.pop().unwrap();
        push(&mut buffers, &inner);
    }
    let text = buffers.pop().unwrap_or_default();
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(line.trim_end());
    }
    out
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_whitespace() && c != '\u{a0}' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(if c == '\u{a0}' { ' ' } else { c });
        }
    }
    out
}

/// The plain title of a note: its first line without Markdown marks.
pub fn title(markdown: &str) -> String {
    markdown
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim_start_matches(['#', '>', '-', ' ', '*'])
        .replace("**", "")
        .trim()
        .chars()
        .take(80)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_the_markup_zotero_notes_use() {
        let html = r#"<div data-schema-version="9"><h1>Reading &amp; ideas</h1>
<p>Main <strong>claim</strong> is <em>bold</em>, see <a href="https://x.org/a?b=1&amp;c=2">link</a>.</p>
<ul><li>first</li><li>second<ol><li>inner</li></ol></li></ul>
<blockquote><p>“A quote” (<span class="citation">Li, 2020, p. 3</span>)</p></blockquote>
<p>x&nbsp;&lt;&#8364;&#x41;</p></div>"#;
        let md = to_markdown(html);
        assert_eq!(
            md,
            "# Reading & ideas\n\nMain **claim** is *bold*, see [link](https://x.org/a?b=1&c=2).\n\n- first\n- second\n  1. inner\n\n> “A quote” (Li, 2020, p. 3)\n\nx <€A"
        );
        assert_eq!(title(&md), "Reading & ideas");
    }
}
