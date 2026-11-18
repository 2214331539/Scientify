//! Links in documents: a page's title, summary, site, icon and cover image for
//! link cards, and its main text for "导入为文档". Fetched here rather than in the
//! page, so other sites' rules on cross-origin requests don't get in the way and
//! pictures arrive as data the app may show.

use crate::agent::web::{client, get, readable};
use base64::{engine::general_purpose::STANDARD, Engine};
use scraper::{Html, Selector};
use serde::Serialize;

const ICON_LIMIT: usize = 64 * 1024;
const IMAGE_LIMIT: usize = 400 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    url: String,
    title: String,
    description: String,
    site: String,
    /// The site's icon and the page's cover picture, as data URLs, when small enough.
    icon: Option<String>,
    image: Option<String>,
}

fn check(address: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(address.trim()).map_err(|_| "请提供完整的网址。")?;
    if !crate::browser::allowed(&url) {
        return Err("只支持 http 和 https 网址。".into());
    }
    Ok(url)
}

/// What the page says about itself in its `<head>`.
pub(crate) fn describe(html: &str, base: &str) -> (LinkPreview, Option<String>, Option<String>) {
    let document = Html::parse_document(html);
    let meta = |names: &[&str]| {
        names.iter().find_map(|name| {
            let css = format!("meta[property=\"{name}\"], meta[name=\"{name}\"]");
            Selector::parse(&css)
                .ok()
                .and_then(|selector| document.select(&selector).next())
                .and_then(|element| element.value().attr("content"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
    };
    let first = |css: &str| {
        Selector::parse(css)
            .ok()
            .and_then(|selector| document.select(&selector).next())
    };
    let base_url = tauri::Url::parse(base).ok();
    let absolute = |href: &str| {
        base_url
            .as_ref()
            .and_then(|base| base.join(href).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(|url| url.to_string())
    };
    let title = meta(&["og:title", "twitter:title"]).unwrap_or_else(|| {
        first("title")
            .map(|t| t.text().collect::<String>().trim().to_string())
            .unwrap_or_default()
    });
    let site = meta(&["og:site_name", "application-name"]).unwrap_or_else(|| {
        base_url
            .as_ref()
            .and_then(|url| url.host_str())
            .unwrap_or_default()
            .trim_start_matches("www.")
            .to_string()
    });
    let image =
        meta(&["og:image", "og:image:url", "twitter:image"]).and_then(|href| absolute(&href));
    let icon =
        first("link[rel~=\"icon\"], link[rel=\"shortcut icon\"], link[rel=\"apple-touch-icon\"]")
            .and_then(|link| link.value().attr("href"))
            .and_then(absolute)
            .or_else(|| absolute("/favicon.ico"));
    let preview = LinkPreview {
        url: base.to_string(),
        title: title.chars().take(200).collect(),
        description: meta(&["og:description", "description", "twitter:description"])
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect(),
        site,
        ..Default::default()
    };
    (preview, icon, image)
}

/// A small picture as a data URL, or nothing when it is missing, not a picture or too big.
async fn picture(url: Option<String>, limit: usize) -> Option<String> {
    let response = client().ok()?.get(url?).send().await.ok()?;
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !response.status().is_success() || !kind.starts_with("image/") {
        return None;
    }
    if response
        .content_length()
        .is_some_and(|size| size as usize > limit)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    (bytes.len() <= limit).then(|| format!("data:{kind};base64,{}", STANDARD.encode(&bytes)))
}

/// A link card's contents.
#[tauri::command]
pub async fn web_link_preview(url: String) -> Result<LinkPreview, String> {
    let url = check(&url)?;
    let (final_url, kind, body) = get(url.as_str()).await?;
    if !kind.is_empty() && !kind.contains("html") {
        return Ok(LinkPreview {
            title: final_url
                .rsplit('/')
                .find(|part| !part.is_empty())
                .unwrap_or(&final_url)
                .to_string(),
            site: url.host_str().unwrap_or_default().to_string(),
            url: final_url,
            ..Default::default()
        });
    }
    let (mut preview, icon, image) = describe(&body, &final_url);
    let (icon, image) = tokio::join!(picture(icon, ICON_LIMIT), picture(image, IMAGE_LIMIT));
    preview.icon = icon;
    preview.image = image;
    Ok(preview)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPage {
    url: String,
    title: String,
    /// The page's main text as Markdown, its source on the first line.
    markdown: String,
}

/// The main text of an article, as Markdown with headings and lists, for a new document.
pub(crate) fn article_markdown(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// A web page's main text, for "导入为文档".
#[tauri::command]
pub async fn web_link_import(url: String) -> Result<ImportedPage, String> {
    let url = check(&url)?;
    let (final_url, kind, body) = get(url.as_str()).await?;
    if !kind.is_empty() && !kind.contains("html") {
        return Err("这个链接不是网页，不能导入为文档。".into());
    }
    let page = readable(&body, &final_url);
    if page.text.trim().is_empty() {
        return Err("没有从这个网页里读到正文。".into());
    }
    let (preview, _, _) = describe(&body, &final_url);
    let title = if preview.title.is_empty() {
        page.title
    } else {
        preview.title
    };
    let markdown = format!(
        "> 来源：[{}]({})\n\n{}",
        title.replace(['[', ']'], ""),
        final_url,
        article_markdown(&page.text)
    );
    Ok(ImportedPage {
        url: final_url,
        title,
        markdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_cards_read_the_page_head() {
        let html = r#"<html><head><title>Fallback</title>
            <meta property="og:title" content="Attention Is All You Need">
            <meta name="description" content="The Transformer paper.">
            <meta property="og:site_name" content="arXiv">
            <meta property="og:image" content="/static/cover.png">
            <link rel="shortcut icon" href="/favicon.png"></head><body></body></html>"#;
        let (preview, icon, image) = describe(html, "https://arxiv.org/abs/1706.03762");
        assert_eq!(preview.title, "Attention Is All You Need");
        assert_eq!(preview.description, "The Transformer paper.");
        assert_eq!(preview.site, "arXiv");
        assert_eq!(image.as_deref(), Some("https://arxiv.org/static/cover.png"));
        assert_eq!(icon.as_deref(), Some("https://arxiv.org/favicon.png"));
        let (bare, icon, image) = describe("<title> Plain </title>", "https://www.example.com/a");
        assert_eq!(
            (bare.title.as_str(), bare.site.as_str()),
            ("Plain", "example.com")
        );
        assert_eq!(icon.as_deref(), Some("https://www.example.com/favicon.ico"));
        assert!(image.is_none());
    }

    #[test]
    fn imported_articles_become_markdown_paragraphs() {
        assert_eq!(
            article_markdown("# Results\nAccuracy rose.\n\n- One\n- Two"),
            "# Results\n\nAccuracy rose.\n\n- One\n\n- Two"
        );
    }
}

#[cfg(test)]
mod live {
    /// Reads a real page: `cargo test -p scientify --lib weblink::live -- --ignored`.
    #[test]
    #[ignore]
    fn a_real_page_becomes_a_card_and_a_document() {
        let preview = tauri::async_runtime::block_on(super::web_link_preview(
            "https://www.rust-lang.org/".into(),
        ))
        .unwrap();
        assert!(preview.title.contains("Rust"), "{preview:?}");
        assert!(preview.icon.is_some(), "{preview:?}");
        let page = tauri::async_runtime::block_on(super::web_link_import(
            "https://www.rust-lang.org/".into(),
        ))
        .unwrap();
        assert!(page.markdown.starts_with("> 来源："), "{}", page.markdown);
        println!(
            "{} | {} | {}",
            preview.title, preview.site, preview.description
        );
    }
}
