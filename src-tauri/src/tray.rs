//! One application tray; Yita's embedded windows do not create a second icon.
use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Runtime,
};

struct TranslationToggle<R: Runtime>(CheckMenuItem<R>);

pub fn update<R: Runtime>(app: &tauri::AppHandle<R>, status: &Value) {
    if let (Some(toggle), Some(enabled)) = (
        app.try_state::<TranslationToggle<R>>(),
        status["enabled"].as_bool(),
    ) {
        if let Err(error) = toggle.0.set_checked(enabled) {
            eprintln!("Scientify tray update: {error}");
        }
    }
}

pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 Scientify", true, None::<&str>)?;
    let enabled =
        CheckMenuItem::with_id(app, "selection", "启用划词翻译", true, true, None::<&str>)?;
    let clipboard = MenuItem::with_id(app, "clipboard", "翻译剪贴板", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "翻译设置…", true, None::<&str>)?;
    let repair = MenuItem::with_id(app, "repair", "修复划词捕获", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &enabled, &clipboard, &settings, &repair])?;
    app.manage(TranslationToggle(enabled));
    let mut tray = TrayIconBuilder::with_id("scientify")
        .tooltip("Scientify · 划词翻译")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref().to_owned();
            let host = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = async {
                    if id == "show" {
                        let window = host.get_webview_window("workspace").or_else(|| host.get_webview_window("main")).ok_or("主窗口不可用。")?;
                        return window.unminimize().and_then(|_| window.show()).and_then(|_| window.set_focus()).map_err(|e| e.to_string());
                    }
                    // Read authoritative Yita settings; native check menus toggle before this callback.
                    let action = if id == "selection" {
                        let status = crate::yita::command(&host, json!({"type":"status"})).await?;
                        json!({"type":"enabled", "enabled": !status["enabled"].as_bool().ok_or("翻译状态无效。")?})
                    } else { json!({"type":id}) };
                    crate::yita::command(&host, action).await.map(|_| ())
                }.await;
                if let Err(error) = result {
                    rfd::AsyncMessageDialog::new().set_title("Scientify 翻译").set_description(error).set_level(rfd::MessageLevel::Error).show().await;
                }
            });
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
