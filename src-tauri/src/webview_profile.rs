//! Native website data stores remain separate from the trusted application UI.
use std::path::PathBuf;
use tauri::{webview::WebviewBuilder, Manager, Runtime, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
fn identifier(profile: &std::path::Path) -> Result<[u8; 16], String> {
    use std::io::Write;
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let path = profile.join("webkit-store-id");
    let id = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            let id = uuid::Uuid::new_v4();
            file.write_all(id.to_string().as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            id
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            uuid::Uuid::parse_str(text.trim()).map_err(|e| format!("Invalid WebKit store: {e}"))?
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(*id.as_bytes())
}

pub fn window<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    profile: PathBuf,
) -> Result<WebviewWindowBuilder<'a, R, M>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(builder.data_store_identifier(identifier(&profile)?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(builder.data_directory(profile))
    }
}

pub fn browser<R: Runtime>(
    builder: WebviewBuilder<R>,
    profile: PathBuf,
) -> Result<WebviewBuilder<R>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(builder.data_store_identifier(identifier(&profile)?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(builder.data_directory(profile))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn persists_profile_identity_and_separates_remote_pages() {
        let root = tempfile::tempdir().unwrap();
        let ui = super::identifier(&root.path().join("ui")).unwrap();
        assert_eq!(ui, super::identifier(&root.path().join("ui")).unwrap());
        assert_ne!(ui, super::identifier(&root.path().join("remote")).unwrap());
    }
}
