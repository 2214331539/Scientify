#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|value| value == "--scientify-runner")
    {
        let result = args
            .get(2)
            .ok_or_else(|| "运行请求文件缺失。".to_string())
            .and_then(|path| scientify_lib::run_managed_experiment(std::path::Path::new(path)));
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    scientify_lib::run();
}
