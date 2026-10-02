//! Translate Scientify's model settings into the engine's configuration.
//!
//! Two decisions are load-bearing here:
//!
//! 1. The API key never reaches disk. The provider declares `env_key`, and the
//!    secret travels in the spawned process's environment instead.
//! 2. Only OpenAI-Responses-compatible protocols can drive the engine. Anthropic
//!    and Gemini speak different wire formats, so they are refused with a reason
//!    rather than written out and left to fail at request time.

/// Environment variable the engine reads the API key from.
pub const KEY_ENV: &str = "SCIENTIFY_AGENT_KEY";

/// Provider id passed in per-process configuration overrides.
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

/// Per-process overrides prevent parallel conversations from rewriting a shared
/// config.toml. Sandbox setup remains the only writer of the shared home config.
pub fn arguments(connection: &Connection<'_>) -> Result<Vec<String>, String> {
    prepare(connection)?;
    let endpoint = connection.endpoint.trim().trim_end_matches('/');
    let endpoint = if connection.provider == "ollama" && !endpoint.ends_with("/v1") {
        format!("{endpoint}/v1")
    } else {
        endpoint.to_string()
    };
    let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    for value in [
        // Conversation history is the memory boundary. Do not synthesize or
        // import cross-thread memory in a CODEX_HOME shared by several projects.
        "features.memories=false".to_string(),
        "features.external_agent_memory_import=false".to_string(),
        format!("model={}", quoted(connection.model.trim())),
        format!("model_provider={}", quoted(PROVIDER_ID)),
        format!("model_providers.{PROVIDER_ID}.name=\"Scientify\""),
        format!(
            "model_providers.{PROVIDER_ID}.base_url={}",
            quoted(&endpoint)
        ),
        format!("model_providers.{PROVIDER_ID}.wire_api=\"responses\""),
        format!("model_providers.{PROVIDER_ID}.requires_openai_auth=false"),
        // Always override a possible env_key left by older Scientify versions.
        format!("model_providers.{PROVIDER_ID}.env_key={}", quoted(KEY_ENV)),
    ] {
        args.extend(["-c".into(), value]);
    }
    if cfg!(windows) {
        args.extend([
            "-c".into(),
            super::execution::WINDOWS_SANDBOX_OVERRIDE.into(),
        ]);
    }
    Ok(args)
}

/// Environment entries the engine process needs.
pub fn environment(connection: &Connection<'_>) -> Vec<(String, String)> {
    match connection
        .api_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => vec![(KEY_ENV.to_string(), key.to_string())],
        None => vec![(KEY_ENV.to_string(), "local-no-key".to_string())],
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
    fn connections_have_independent_overrides_and_no_keys_in_arguments() {
        let first = connection("openai", "https://first.example/v1", Some("secret-first"));
        let second = connection("ollama", "http://localhost:11434", None);
        let first_args = arguments(&first).unwrap().join("\n");
        let second_args = arguments(&second).unwrap().join("\n");
        assert!(first_args.contains("https://first.example/v1"));
        assert!(!second_args.contains("first.example"));
        assert!(second_args.contains("http://localhost:11434/v1"));
        assert!(!first_args.contains("secret-first"));
        assert_eq!(
            environment(&first),
            vec![(KEY_ENV.into(), "secret-first".into())]
        );
        assert_eq!(
            environment(&second),
            vec![(KEY_ENV.into(), "local-no-key".into())]
        );
    }
}
