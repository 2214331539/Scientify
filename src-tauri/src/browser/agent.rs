//! Agent operations reuse the same isolated browser tabs as the literature view.
use super::*;
use serde_json::{json, Value};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

// Fixed read-only extraction, never model-provided JavaScript. Excludes form values.
const READ_PAGE: &str = r#"(() => {
 const root = document.querySelector('main, article, [role="main"]') || document.body;
 if (!root) return {url:location.href,title:document.title,text:'',links:[],truncated:false};
 const clone = root.cloneNode(true);
 clone.querySelectorAll('script,style,noscript,nav,footer,header,form,input,textarea,select,[hidden],[aria-hidden="true"]').forEach(el=>el.remove());
 const raw = clone.textContent || '';
 const links = Array.from(root.querySelectorAll('a[href]')).slice(0,80).map(a=>({title:(a.innerText||a.textContent||'').trim().slice(0,200),url:a.href})).filter(a=>/^https?:/.test(a.url)&&a.url.length<=2048);
 return {url:location.href,title:document.title,text:raw.replace(/\n{3,}/g,'\n\n').slice(0,16000),links,truncated:raw.length>16000,blocked:!!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#captcha,input[type="password"]')};
})()"#;

fn scoped(
    app: &tauri::AppHandle,
    owner: &str,
    project: &str,
    id: &str,
) -> Result<BrowserTab, String> {
    let tab = get(app, owner, id)?;
    if tab.project_id != project {
        return Err("网页不属于当前会话项目。".into());
    }
    Ok(tab)
}

pub(crate) fn operate(
    app: &tauri::AppHandle,
    owner: &str,
    project: &str,
    tool: &str,
    args: Value,
    cancelled: impl Fn() -> bool,
) -> Result<Value, String> {
    if cancelled() {
        return Err("网页任务已中止。".into());
    }
    if tool == "scientify_browser_tabs" {
        let _: Empty = serde_json::from_value(args).map_err(|e| e.to_string())?;
        let mut tabs: Vec<_> = owner_tabs(app, owner)?
            .into_iter()
            .filter(|t| t.project_id == project)
            .collect();
        tabs.sort_by(|a, b| a.id.cmp(&b.id));
        return Ok(json!({"tabs":tabs}));
    }
    let tab = match tool {
        "scientify_browser_read" => {
            let input: Read = serde_json::from_value(args).map_err(|e| e.to_string())?;
            scoped(app, owner, project, &input.tab_id)?
        }
        "scientify_browser_open" | "scientify_browser_search" => {
            let (tab_id, address) = if tool == "scientify_browser_open" {
                let input: Open = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let parsed = tauri::Url::parse(&input.url)
                    .map_err(|_| "请输入完整的 HTTP 或 HTTPS 链接。")?;
                if !allowed(&parsed) {
                    return Err("不允许打开此地址。".into());
                }
                (input.tab_id, parsed)
            } else {
                let input: Search = serde_json::from_value(args).map_err(|e| e.to_string())?;
                if input.query.trim().is_empty() || input.query.len() > 1000 {
                    return Err("搜索词为空或过长。".into());
                }
                let mut url = tauri::Url::parse("https://www.google.com/search")
                    .map_err(|e| e.to_string())?;
                url.query_pairs_mut().append_pair("q", input.query.trim());
                (input.tab_id, url)
            };
            let tab = if let Some(id) = tab_id {
                scoped(app, owner, project, &id)?
            } else {
                create_tab(app, owner, project)?
            };
            if cancelled() {
                return Err("网页任务已中止。".into());
            }
            navigate(app, &tab, address)?;
            let mut created =
                serde_json::to_value(get(app, owner, &tab.id)?).map_err(|e| e.to_string())?;
            created["background"] = json!(true);
            app.emit_to(owner, "browser-created", created)
                .map_err(|e| e.to_string())?;
            tab
        }
        _ => return Err("未知的浏览器工具。".into()),
    };
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if cancelled() {
            return Err("网页任务已中止。".into());
        }
        if Instant::now() >= deadline {
            return Err("网页加载超时，可在浏览器检查页面后重试读取。".into());
        }
        let current = scoped(app, owner, project, &tab.id)?;
        if let Some(error) = current.error {
            return Err(format!("网页加载失败：{error}"));
        }
        if !current.loading && !current.url.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let view = app.get_webview(&tab.id).ok_or("网页已关闭。")?;
    let (tx, rx) = mpsc::channel();
    view.eval_with_callback(READ_PAGE, move |value| {
        let _ = tx.send(value);
    })
    .map_err(|e| e.to_string())?;
    let raw = loop {
        if cancelled() {
            return Err("网页任务已中止。".into());
        }
        if Instant::now() >= deadline {
            return Err("读取网页超时，请重试。".into());
        }
        scoped(app, owner, project, &tab.id)?;
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => break value,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => return Err(error.to_string()),
        }
    };
    if raw.len() > 256 * 1024 {
        return Err("网页提取结果超过大小限制。".into());
    }
    let page: Page =
        serde_json::from_str(&raw).map_err(|_| "网页正文提取失败，请在浏览器检查登录或验证码。")?;
    let current = scoped(app, owner, project, &tab.id)?;
    let url = tauri::Url::parse(&page.url).map_err(|e| e.to_string())?;
    if !allowed(&url) || current.url != page.url || current.loading {
        return Err("网页在读取期间发生跳转，请重试。".into());
    }
    if page.text.trim().is_empty() {
        return Err("页面没有可提取的正文，可能需要登录或尚未加载完成。".into());
    }
    if page.blocked {
        return Err("页面需要登录或验证码，请在浏览器中处理后重试。".into());
    }
    let text: String = page.text.chars().take(16000).collect();
    Ok(
        json!({"tabId":tab.id,"url":page.url,"title":page.title,"text":text,"links":page.links,"truncated":page.truncated,"source":"untrusted-web-page"}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    tab_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    url: String,
    tab_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    query: String,
    tab_id: Option<String>,
}
#[derive(Deserialize)]
struct Page {
    url: String,
    title: String,
    text: String,
    links: Value,
    truncated: bool,
    #[serde(default)]
    blocked: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_arguments_cannot_supply_scripts_or_project_identity() {
        assert!(serde_json::from_value::<Read>(json!({"tabId":"a","projectId":"other"})).is_err());
        assert!(serde_json::from_value::<Open>(
            json!({"url":"https://example.org","script":"steal()"})
        )
        .is_err());
    }
}
