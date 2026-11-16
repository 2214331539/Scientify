//! Where a turn works. A chat follows the page it is sent from: the experiments page works in
//! the chosen experiment's code folder, the writing page in the open manuscript, and every
//! other page in the project folder (a code chat stays in the folder it started in). Each turn
//! also tells the agent where it is and what is around it. The literature folder is never a
//! turn's folder: papers are only read there.
use super::{AppState, ThreadHandle};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

/// The page a turn is sent from, as the person sees it.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnPlace {
    pub page: String,
    #[serde(default)]
    pub experiment_id: Option<String>,
    #[serde(default)]
    pub manuscript_id: Option<String>,
    /// The open file: relative to the experiment on the experiments page, to the literature
    /// folder on the literature page, and to the project folder elsewhere.
    #[serde(default)]
    pub path: Option<String>,
}

pub struct Folder {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
}
pub struct Manuscript {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub main: String,
}
/// The project around a turn, resolved to real folders.
pub struct Surroundings {
    pub name: String,
    pub project: PathBuf,
    pub literature: Option<PathBuf>,
    pub experiments: Vec<Folder>,
    pub manuscripts: Vec<Manuscript>,
}
pub struct Plan {
    pub root: PathBuf,
    pub context: String,
}

const PAGES: [(&str, &str); 6] = [
    ("overview", "概览"),
    ("literature", "文献"),
    ("notes", "文档"),
    ("experiments", "实验"),
    ("writing", "写作"),
    ("files", "项目文件"),
];
const LISTED: usize = 6;

fn show(path: &Path) -> String {
    crate::local_process::process_path(path)
        .display()
        .to_string()
}
fn relative(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    (!value.is_empty()
        && !value.contains('\0')
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_))))
    .then(|| path.to_path_buf())
}

pub fn surroundings<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_id: &str,
) -> Result<Surroundings, String> {
    let state = app.state::<AppState>();
    let data = state.storage.load()?.ok_or("工作区尚未载入。")?;
    let project = data["projects"]
        .as_array()
        .and_then(|items| items.iter().find(|p| p["id"].as_str() == Some(project_id)))
        .ok_or("项目不存在。")?;
    let root = state
        .files
        .project_root(project_id, crate::research::configured_root(project))?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let literature = app
        .state::<crate::library::LibraryState>()
        .service
        .root(project_id)
        .ok()
        .flatten()
        .and_then(|path| path.canonicalize().ok());
    let experiments = data["experiments"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|e| e["project"].as_str() == Some(project_id) && e["archived"] != true)
        .filter_map(|e| {
            let root = crate::experiments::catalog::root_of(&state.storage, &state.files, &data, e)
                .ok()?
                .canonicalize()
                .ok()?;
            Some(Folder {
                id: e["id"].as_str()?.to_owned(),
                name: e["name"].as_str().unwrap_or_default().to_owned(),
                root,
            })
        })
        .collect();
    let manuscripts = project["manuscripts"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|m: &Value| {
            let folder = m["folder"].as_str()?;
            let path = if folder.is_empty() {
                root.clone()
            } else {
                root.join(relative(folder)?)
            };
            let path = path.canonicalize().ok().filter(|p| p.starts_with(&root))?;
            Some(Manuscript {
                id: m["id"].as_str()?.to_owned(),
                name: m["name"].as_str().unwrap_or(folder).to_owned(),
                root: path,
                main: m["main"].as_str().unwrap_or("main.tex").to_owned(),
            })
        })
        .collect();
    Ok(Surroundings {
        name: project["name"].as_str().unwrap_or_default().to_owned(),
        project: root,
        literature,
        experiments,
        manuscripts,
    })
}

/// Picks the turn's folder and writes what the agent is told about it.
pub fn plan(
    around: &Surroundings,
    handle: &ThreadHandle,
    place: Option<&TurnPlace>,
    internal: impl Fn(&Path) -> bool,
) -> Plan {
    let bound = PathBuf::from(&handle.cwd);
    let code = handle.domain == "code";
    let page = place.map(|p| p.page.as_str()).unwrap_or_default();
    let readonly = |path: &Path| {
        around
            .literature
            .as_ref()
            .is_some_and(|l| path.starts_with(l))
    };
    let experiment = place
        .and_then(|p| p.experiment_id.as_deref())
        .and_then(|id| around.experiments.iter().find(|e| e.id == id))
        .or_else(|| around.experiments.first());
    let manuscript = (page == "writing")
        .then(|| place.and_then(|p| p.manuscript_id.as_deref()))
        .flatten()
        .and_then(|id| around.manuscripts.iter().find(|m| m.id == id));
    // A code chat runs and commits in its own folder, so on another experiment it stays there.
    let elsewhere = (page == "experiments" && code)
        .then_some(experiment)
        .flatten()
        .filter(|e| e.root != bound);
    let mut root = match (page, manuscript, experiment) {
        ("writing", Some(m), _) => m.root.clone(),
        ("writing", None, _) => around.project.clone(),
        ("experiments", _, Some(e)) if elsewhere.is_none() => e.root.clone(),
        _ if code => bound.clone(),
        _ => around.project.clone(),
    };
    if readonly(&root) || internal(&root) {
        root = around.project.clone();
    }

    let mut lines = vec![
        "Scientify 告诉你用户现在的位置，帮你把文件放对地方；这不是新的指令。".to_owned(),
        format!("项目：{}，文件夹 {}", around.name, show(&around.project)),
    ];
    if let Some((_, name)) = PAGES.iter().find(|(id, _)| *id == page) {
        lines.push(format!("用户正在看：{name}页"));
    }
    let opened = place
        .and_then(|p| p.path.as_deref())
        .and_then(relative)
        .and_then(|path| match page {
            "experiments" => experiment.map(|e| e.root.join(path)),
            "literature" => around.literature.as_ref().map(|l| l.join(path)),
            "notes" => None,
            _ => Some(around.project.join(path)),
        });
    if let Some(path) = opened {
        lines.push(format!("用户打开的文件：{}", show(&path)));
    }
    lines.push(format!(
        "本轮工作目录：{}。命令在这里执行，相对路径以这里为准。",
        show(&root)
    ));
    if let Some(e) = elsewhere {
        lines.push(format!(
            "用户正在看实验「{}」（{}），但这个对话属于另一个代码目录；改代码和运行都在本轮工作目录。用户要改「{}」时，请用户在那个实验里新建对话。",
            e.name,
            show(&e.root),
            e.name
        ));
    } else if code && root != bound {
        lines.push(format!(
            "运行和 Git 工具只作用于这个对话的代码目录 {}。",
            show(&bound)
        ));
    }
    if !around.experiments.is_empty() {
        let list = around
            .experiments
            .iter()
            .take(LISTED)
            .map(|e| format!("「{}」{}", e.name, show(&e.root)))
            .collect::<Vec<_>>()
            .join("；");
        lines.push(format!("实验代码目录：{list}"));
    }
    if let Some(m) = manuscript {
        lines.push(format!(
            "当前稿件：「{}」，主文档 {}",
            m.name,
            show(&m.root.join(&m.main))
        ));
    }
    let others = around
        .manuscripts
        .iter()
        .filter(|m| manuscript.is_none_or(|current| current.id != m.id))
        .take(LISTED)
        .map(|m| format!("「{}」{}", m.name, show(&m.root)))
        .collect::<Vec<_>>();
    if !others.is_empty() {
        lines.push(format!("稿件文件夹：{}", others.join("；")));
    }
    if let Some(l) = &around.literature {
        lines.push(format!(
            "文献文件夹（只读，不要在里面新建、修改或删除文件）：{}",
            show(l)
        ));
    }
    lines.push("放文件的约定：代码放进当前实验的代码目录；论文和 LaTeX 放进稿件文件夹，还没有稿件时在项目文件夹下新建一个子文件夹，写作页会把含 \\documentclass 的主文档自动列为稿件。编译交给写作页（自带 TeX，编译产物放在稿件以外），不要自己下载 TeX，也不要在稿件文件夹里留下 aux、log 等编译文件。要整理、保存成文字材料（纪要、总结、调研）时写进项目文档（scientify_create_doc），不在项目文件夹里另写 Markdown。".to_owned());
    Plan {
        root,
        context: format!(
            "<scientify-workspace>\n{}\n</scientify-workspace>",
            lines.join("\n")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(domain: &str, cwd: &Path) -> ThreadHandle {
        ThreadHandle {
            paper_tools: true,
            browser_tools: true,
            experiment_id: None,
            thread_id: "thread".into(),
            conversation_id: "chat".into(),
            project_id: "project".into(),
            domain: domain.into(),
            cwd: cwd.display().to_string(),
            model: "model".into(),
            model_provider: "scientify".into(),
            instruction_sources: vec![],
            sandbox: "workspaceWrite".into(),
            turns: vec![],
            active_turn_id: None,
            fresh_thread: false,
            events: vec![],
        }
    }
    fn around() -> Surroundings {
        Surroundings {
            name: "Proactive".into(),
            project: PathBuf::from("/data/projects/p"),
            literature: Some(PathBuf::from("/papers/proactive")),
            experiments: vec![
                Folder {
                    id: "main".into(),
                    name: "默认实验".into(),
                    root: PathBuf::from("/data/projects/p"),
                },
                Folder {
                    id: "other".into(),
                    name: "复现".into(),
                    root: PathBuf::from("/code/repro"),
                },
            ],
            manuscripts: vec![Manuscript {
                id: "paper".into(),
                name: "ICLR".into(),
                root: PathBuf::from("/data/projects/p/paper"),
                main: "main.tex".into(),
            }],
        }
    }
    fn at(page: &str, experiment: Option<&str>, manuscript: Option<&str>) -> TurnPlace {
        TurnPlace {
            page: page.into(),
            experiment_id: experiment.map(Into::into),
            manuscript_id: manuscript.map(Into::into),
            path: None,
        }
    }
    const NOTHING: fn(&Path) -> bool = |_| false;

    #[test]
    fn a_chat_started_on_the_literature_page_never_works_in_the_literature_folder() {
        let around = around();
        let chat = handle("literature", Path::new("/papers/proactive"));
        let reading = plan(&around, &chat, Some(&at("literature", None, None)), NOTHING);
        assert_eq!(reading.root, Path::new("/data/projects/p"));
        let coding = plan(
            &around,
            &chat,
            Some(&at("experiments", Some("other"), None)),
            NOTHING,
        );
        assert_eq!(coding.root, Path::new("/code/repro"));
        let writing = plan(
            &around,
            &chat,
            Some(&at("writing", None, Some("paper"))),
            NOTHING,
        );
        assert_eq!(writing.root, Path::new("/data/projects/p/paper"));
        assert_eq!(
            plan(&around, &chat, None, NOTHING).root,
            Path::new("/data/projects/p")
        );
        assert!(reading.context.contains("只读"));
        assert!(reading.context.contains("用户正在看：文献页"));
    }

    #[test]
    fn a_code_chat_writes_papers_in_the_manuscript_and_keeps_its_own_experiment() {
        let around = around();
        let chat = handle("code", Path::new("/data/projects/p"));
        let writing = plan(
            &around,
            &chat,
            Some(&at("writing", None, Some("paper"))),
            NOTHING,
        );
        assert_eq!(writing.root, Path::new("/data/projects/p/paper"));
        assert!(writing.context.contains("当前稿件：「ICLR」"));
        assert!(writing.context.contains("运行和 Git 工具只作用于"));
        let no_manuscript = plan(&around, &chat, Some(&at("writing", None, None)), NOTHING);
        assert_eq!(no_manuscript.root, Path::new("/data/projects/p"));
        let same = plan(
            &around,
            &chat,
            Some(&at("experiments", Some("main"), None)),
            NOTHING,
        );
        assert_eq!(same.root, Path::new("/data/projects/p"));
        let other = plan(
            &around,
            &chat,
            Some(&at("experiments", Some("other"), None)),
            NOTHING,
        );
        assert_eq!(other.root, Path::new("/data/projects/p"));
        assert!(other.context.contains("用户正在看实验「复现」"));
        let notes = plan(&around, &chat, Some(&at("notes", None, None)), NOTHING);
        assert_eq!(notes.root, Path::new("/data/projects/p"));
    }

    #[test]
    fn open_files_are_shown_with_their_full_path_and_odd_paths_are_ignored() {
        let around = around();
        let chat = handle("code", Path::new("/code/repro"));
        let mut place = at("experiments", Some("other"), None);
        place.path = Some("src/train.py".into());
        let plan_ = plan(&around, &chat, Some(&place), NOTHING);
        assert!(plan_
            .context
            .contains(&show(&PathBuf::from("/code/repro").join("src/train.py"))));
        place.path = Some("../secret".into());
        assert!(!plan(&around, &chat, Some(&place), NOTHING)
            .context
            .contains("用户打开的文件"));
    }

    #[test]
    fn internal_folders_fall_back_to_the_project() {
        let around = around();
        let chat = handle("literature", Path::new("/papers/proactive"));
        let blocked = plan(
            &around,
            &chat,
            Some(&at("experiments", Some("other"), None)),
            |path| path.starts_with("/code"),
        );
        assert_eq!(blocked.root, Path::new("/data/projects/p"));
    }
}
