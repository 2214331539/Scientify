//! Translate Scientify's model settings into the engine's configuration.
//!
//! Two decisions are load-bearing here:
//!
//! 1. The API key never reaches disk. The provider declares `env_key`, and the
//!    secret travels in the spawned process's environment instead.
//! 2. Only OpenAI-Responses-compatible protocols can drive the engine. Anthropic
//!    and Gemini speak different wire formats, so they are refused with a reason
//!    rather than written out and left to fail at request time.

use std::path::Path;

/// Environment variable the engine reads the API key from.
pub const KEY_ENV: &str = "SCIENTIFY_AGENT_KEY";

/// Provider id written into `config.toml`.
const PROVIDER_ID: &str = "scientify";

pub struct Connection<'a> {
    pub endpoint: &'a str,
    pub model: &'a str,
    pub provider: &'a str,
    pub api_key: Option<&'a str>,
}

/// TOML basic strings accept the same escapes as JSON for the characters that
/// can appear in a URL or model name.
fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn valid_endpoint(endpoint: &str) -> Result<(), String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err("模型服务地址无效。".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("模型服务地址必须以 http:// 或 https:// 开头。".into());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("模型服务地址不能包含空白字符。".into());
    }
    Ok(())
}

fn valid_model(model: &str) -> Result<(), String> {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err("请先选择模型。".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("模型名称无效。".into());
    }
    Ok(())
}

/// Check the connection and return the provider protocol the engine will use.
pub fn prepare(connection: &Connection<'_>) -> Result<(), String> {
    valid_endpoint(connection.endpoint)?;
    valid_model(connection.model)?;
    match connection.provider {
        // Both expose an OpenAI-shaped surface; anything else would need a
        // translating proxy that this project does not ship.
        "openai" | "ollama" => Ok(()),
        "anthropic" | "gemini" => Err(
            "内置 Agent 引擎使用 OpenAI Responses 协议，暂不支持该服务商的原始协议。请选择 OpenAI 兼容的服务商。"
                .into(),
        ),
        _ => Err("未知的模型服务协议。".into()),
    }
}

/// Write `config.toml` for one domain.
pub fn write(home: &Path, connection: &Connection<'_>) -> Result<(), String> {
    prepare(connection)?;
    // The Windows sandbox setup writes its own `[windows]` settings into this
    // file. Keep that section when refreshing the model connection; replacing
    // the whole file used to erase the setup on the next app launch.
    let previous = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let windows_section = previous
        .lines()
        .enumerate()
        .find(|(_, line)| line.trim() == "[windows]")
        .map(|(start, _)| {
            let mut section = Vec::new();
            for line in previous.lines().skip(start) {
                if !section.is_empty() && line.trim_start().starts_with('[') {
                    break;
                }
                section.push(line);
            }
            section.join("\n")
        });

    let mut text = String::new();
    text.push_str("# 由 Scientify 生成，用于内置 Agent 引擎。请通过应用界面修改。\n");
    text.push_str(&format!("model = {}\n", quoted(connection.model.trim())));
    text.push_str(&format!("model_provider = {}\n\n", quoted(PROVIDER_ID)));
    text.push_str(&format!("[model_providers.{PROVIDER_ID}]\n"));
    text.push_str("name = \"Scientify\"\n");
    text.push_str(&format!(
        "base_url = {}\n",
        quoted(connection.endpoint.trim().trim_end_matches('/'))
    ));
    // The engine only speaks the Responses wire format.
    text.push_str("wire_api = \"responses\"\n");
    if connection.api_key.is_some_and(|key| !key.trim().is_empty()) {
        text.push_str(&format!("env_key = {}\n", quoted(KEY_ENV)));
    }
    // A key supplied by the application is not a ChatGPT login.
    text.push_str("requires_openai_auth = false\n");
    if let Some(section) = windows_section.filter(|section| !section.trim().is_empty()) {
        text.push('\n');
        text.push_str(&section);
        text.push('\n');
    }

    std::fs::create_dir_all(home).map_err(|e| format!("无法创建 Agent 数据目录：{e}"))?;
    let target = home.join("config.toml");
    let pending = home.join("config.pending.toml");
    std::fs::write(&pending, text).map_err(|e| format!("无法写入 Agent 配置：{e}"))?;
    std::fs::rename(&pending, &target).map_err(|e| format!("无法写入 Agent 配置：{e}"))?;
    Ok(())
}

/// Environment entries the engine process needs.
pub fn environment(connection: &Connection<'_>) -> Vec<(String, String)> {
    match connection
        .api_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => vec![(KEY_ENV.to_string(), key.to_string())],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection<'a>(
        provider: &'a str,
        endpoint: &'a str,
        key: Option<&'a str>,
    ) -> Connection<'a> {
        Connection {
            endpoint,
            model: "test-model",
            provider,
            api_key: key,
        }
    }

    #[test]
    fn only_openai_shaped_protocols_are_accepted() {
        assert!(prepare(&connection("openai", "https://api.openai.com/v1", None)).is_ok());
        assert!(prepare(&connection("ollama", "http://127.0.0.1:11434", None)).is_ok());
        // A different wire format would fail at request time, so it is refused up front.
        assert!(prepare(&connection(
            "anthropic",
            "https://api.anthropic.com/v1",
            None
        ))
        .is_err());
        assert!(prepare(&connection(
            "gemini",
            "https://generativelanguage.googleapis.com",
            None
        ))
        .is_err());
    }

    #[test]
    fn endpoints_are_constrained_so_a_value_cannot_break_out_of_its_line() {
        assert!(prepare(&connection("openai", "api.openai.com", None)).is_err());
        assert!(prepare(&connection("openai", "https://a b/v1", None)).is_err());
        assert!(prepare(&connection("openai", "", None)).is_err());
    }

    #[test]
    fn quoted_values_escape_toml_metacharacters() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(quoted("line\nbreak"), r#""line\nbreak""#);
    }

    #[test]
    fn the_key_is_passed_through_the_environment_rather_than_the_file() {
        let with_key = connection("openai", "https://api.openai.com/v1", Some("sk-secret"));
        let env = environment(&with_key);
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, KEY_ENV);
        assert_eq!(env[0].1, "sk-secret");
        // What gets written declares where to read the key; it never contains it.
        let home = std::env::temp_dir().join(format!("scientify-config-{}", std::process::id()));
        write(&home, &with_key).unwrap();
        let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(text.contains("env_key = \"SCIENTIFY_AGENT_KEY\""));
        assert!(!text.contains("sk-secret"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_missing_key_omits_the_env_key_line() {
        let without = connection("ollama", "http://127.0.0.1:11434", None);
        assert!(environment(&without).is_empty());
        let home =
            std::env::temp_dir().join(format!("scientify-config-nokey-{}", std::process::id()));
        write(&home, &without).unwrap();
        let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(!text.contains("env_key"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn refreshing_connection_keeps_windows_sandbox_configuration() {
        let home =
            std::env::temp_dir().join(format!("scientify-config-windows-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.toml"),
            "[windows]\nsandbox = \"elevated\"\nsandbox_private_desktop = false\n",
        )
        .unwrap();
        write(
            &home,
            &connection("openai", "https://api.openai.com/v1", None),
        )
        .unwrap();
        let text = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(text.contains("[windows]"));
        assert!(text.contains("sandbox = \"elevated\""));
        assert!(text.contains("sandbox_private_desktop = false"));
        std::fs::remove_dir_all(&home).ok();
    }
}
