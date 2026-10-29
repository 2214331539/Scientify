use crate::{library::LibraryState, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use scientify_core::research::reject_links;
use serde::Deserialize;
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{Manager, State};

const IMAGE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImageOperation {
    Save { data: String },
    Read { path: String },
}

fn image_type(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("gif", "image/gif"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok(("webp", "image/webp"))
    } else {
        Err("图片需为 PNG、JPEG、WebP 或 GIF，且不超过 8 MiB。".into())
    }
}

fn resolve_image(root: &Path, parent: &Path, path: &str) -> Result<PathBuf, String> {
    if path.contains(['\\', ':', '\0']) || Path::new(path).is_absolute() {
        return Err("图片必须位于当前笔记目录中。".into());
    }
    let mut result = parent.to_path_buf();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(name) => result.push(name),
            Component::CurDir => {}
            Component::ParentDir if result != root => {
                result.pop();
            }
            _ => return Err("图片路径超出了当前笔记目录。".into()),
        }
    }
    if !result.starts_with(root) {
        return Err("图片路径超出了当前笔记目录。".into());
    }
    reject_links(&result)?;
    Ok(result)
}

fn image_operation(
    root: &Path,
    parent: &Path,
    assets: &Path,
    operation: ImageOperation,
) -> Result<String, String> {
    reject_links(root)?;
    match operation {
        ImageOperation::Save { data } => {
            if data.len() > IMAGE_LIMIT * 4 / 3 + 4 {
                return Err("图片超过 8 MiB。".into());
            }
            let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效。")?;
            if bytes.len() > IMAGE_LIMIT {
                return Err("图片超过 8 MiB。".into());
            }
            let (extension, _) = image_type(&bytes)?;
            reject_links(assets)?;
            std::fs::create_dir_all(assets).map_err(|e| e.to_string())?;
            let name = format!("{}.{}", uuid::Uuid::new_v4(), extension);
            let path = assets.join(&name);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            let levels = parent
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .components()
                .count();
            Ok(format!(
                "{}{}",
                "../".repeat(levels),
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
            ))
        }
        ImageOperation::Read { path } => {
            let path = resolve_image(root, parent, &path)?;
            let mut bytes = Vec::new();
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take((IMAGE_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > IMAGE_LIMIT {
                return Err("图片超过 8 MiB。".into());
            }
            let (_, mime) = image_type(&bytes)?;
            Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        }
    }
}

#[tauri::command]
pub async fn note_image<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    paper_id: Option<String>,
    operation: ImageOperation,
) -> Result<String, String> {
    crate::library::trusted(&view)?;
    let storage = state.storage.clone();
    let library = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = storage.load()?.ok_or("工作区尚未载入。")?;
        if project_id != "__inbox__"
            && !workspace["projects"]
                .as_array()
                .is_some_and(|items| items.iter().any(|p| p["id"] == project_id))
        {
            return Err("项目不存在。".into());
        }
        let (root, parent, assets) = if let Some(id) = paper_id {
            let root = library.root(&project_id)?.ok_or("请先打开文献文件夹。")?;
            let binding = library
                .binding(&project_id, &id)?
                .ok_or("文献绑定不存在。")?;
            let parent = root
                .join(binding.note_path)
                .parent()
                .ok_or("笔记路径无效。")?
                .to_path_buf();
            let assets = root.join(".scientify").join("note-assets");
            (root, parent, assets)
        } else {
            if project_id.is_empty()
                || !project_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            {
                return Err("项目标识无效。".into());
            }
            let root = storage.directory().join("note-assets").join(&project_id);
            (root.clone(), root.clone(), root.join("images"))
        };
        image_operation(&root, &parent, &assets, operation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn note_images_roundtrip_with_relative_paths_and_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let parent = root.join("papers");
        std::fs::create_dir_all(&parent).unwrap();
        let assets = root.join(".scientify/note-assets");
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let path = image_operation(
            root,
            &parent,
            &assets,
            ImageOperation::Save {
                data: STANDARD.encode(bytes),
            },
        )
        .unwrap();
        assert!(path.starts_with("../.scientify/note-assets/"));
        assert_eq!(
            image_operation(root, &parent, &assets, ImageOperation::Read { path }).unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(bytes))
        );
        for path in [
            "../../outside.png",
            "C:/secret.png",
            "//server/share",
            "../secret.txt",
        ] {
            assert!(image_operation(
                root,
                &parent,
                &assets,
                ImageOperation::Read { path: path.into() }
            )
            .is_err());
        }
        assert!(image_operation(
            root,
            &parent,
            &assets,
            ImageOperation::Save {
                data: STANDARD.encode(b"<svg/>")
            }
        )
        .is_err());
    }
}
