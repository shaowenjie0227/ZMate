use crate::core::models::{
    AppSettings, CleanPayload, CoreEnvelope, DiagnosePathCheck, DiagnosePayload,
    UpdateInstallabilityPayload, ZcodeProxyPayload,
};
use crate::core::settings as app_settings;
use crate::core::zcode_proxy as zcode_proxy_core;
use crate::platform::paths::ZCodePaths;
use crate::platform::process;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub hostname: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePayload {
    pub zcode_home: String,
    pub provider_config_path: String,
    pub cli_config_path: String,
    pub skills_dir: String,
    pub agents_md_path: String,
    pub tasks_db_path: String,
    pub session_db_path: String,
    pub app_data_dir: String,
    pub settings: AppSettings,
    pub zcode_running: bool,
}

#[tauri::command]
pub fn load_app_state(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<AppStatePayload>, String> {
    let settings = app_settings::load_settings(&paths);
    let payload = AppStatePayload {
        zcode_home: paths.zcode_home.to_string_lossy().to_string(),
        provider_config_path: paths.provider_config_path.to_string_lossy().to_string(),
        cli_config_path: paths.cli_config_path.to_string_lossy().to_string(),
        skills_dir: paths.skills_dir.to_string_lossy().to_string(),
        agents_md_path: paths.agents_md_path.to_string_lossy().to_string(),
        tasks_db_path: paths.tasks_db_path.to_string_lossy().to_string(),
        session_db_path: paths.session_db_path.to_string_lossy().to_string(),
        app_data_dir: paths.app_data_dir.to_string_lossy().to_string(),
        settings,
        zcode_running: process::is_zcode_running(),
    };
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn set_check_zcode_running(
    paths: State<'_, Arc<ZCodePaths>>,
    enabled: bool,
) -> Result<CoreEnvelope<AppSettings>, String> {
    let mut settings = app_settings::load_settings(&paths);
    settings.check_zcode_running = enabled;
    app_settings::save_settings(&paths, &settings).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(settings))
}

#[tauri::command]
pub fn is_zcode_running() -> Result<CoreEnvelope<bool>, String> {
    Ok(CoreEnvelope::ok(process::is_zcode_running()))
}

#[tauri::command]
pub fn load_zcode_proxy(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<ZcodeProxyPayload>, String> {
    let payload = zcode_proxy_core::load_zcode_proxy(&paths).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn set_zcode_proxy(
    paths: State<'_, Arc<ZCodePaths>>,
    input: zcode_proxy_core::ZcodeProxyInput,
) -> Result<CoreEnvelope<ZcodeProxyPayload>, String> {
    let payload = zcode_proxy_core::set_zcode_proxy(&paths, &input).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn restart_zcode() -> Result<CoreEnvelope<()>, String> {
    process::restart_zcode()
        .map(|()| CoreEnvelope::ok(()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagnose(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<DiagnosePayload>, String> {
    let path = |p: &std::path::Path, key: &str| DiagnosePathCheck {
        key: key.to_string(),
        path: p.to_string_lossy().to_string(),
        exists: p.exists(),
    };
    let path_checks = vec![
        path(&paths.zcode_home, "zcodeHome"),
        path(&paths.provider_config_path, "providerConfig"),
        path(&paths.cli_config_path, "cliConfig"),
        path(&paths.skills_dir, "skillsDir"),
        path(&paths.agents_md_path, "agentsMd"),
        path(&paths.tasks_db_path, "tasksDb"),
        path(&paths.session_db_path, "sessionDb"),
        path(&paths.rollout_dir, "rolloutDir"),
        path(&paths.app_data_dir, "appDataDir"),
    ];

    let (provider_config_valid, provider_config_error) = check_json_file(&paths.provider_config_path);
    let (cli_config_valid, cli_config_error) = check_json_file(&paths.cli_config_path);

    Ok(CoreEnvelope::ok(DiagnosePayload {
        zcode_home: paths.zcode_home.to_string_lossy().to_string(),
        core_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        zcode_running: process::is_zcode_running(),
        path_checks,
        provider_config_valid,
        provider_config_error,
        cli_config_valid,
        cli_config_error,
        session_db_exists: paths.session_db_path.exists(),
        tasks_db_exists: paths.tasks_db_path.exists(),
    }))
}

fn check_json_file(path: &std::path::Path) -> (bool, Option<String>) {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(_) => (true, None),
            Err(e) => (false, Some(format!("JSON 解析失败：{e}"))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (true, None),
        Err(e) => (false, Some(format!("读取失败：{e}"))),
    }
}

#[tauri::command]
pub fn clean(paths: State<'_, Arc<ZCodePaths>>) -> Result<CoreEnvelope<CleanPayload>, String> {
    let provider = clean_dir_files(&paths.provider_config_backups_dir);
    let skill = clean_dir_all_children(&paths.skill_backups_dir);
    let instruction = clean_dir_files(&paths.custom_instruction_history_dir);
    paths.ensure_app_directories().map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(CleanPayload {
        provider_backups_removed: provider,
        skill_backups_removed: skill,
        instruction_history_removed: instruction,
    }))
}

fn clean_dir_files(dir: &std::path::Path) -> i32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_file() && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn clean_dir_all_children(dir: &std::path::Path) -> i32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        let is_dir = p.is_dir();
        let remove_ok = if is_dir {
            std::fs::remove_dir_all(&p).is_ok()
        } else {
            std::fs::remove_file(&p).is_ok()
        };
        if remove_ok {
            removed += 1;
        }
    }
    removed
}

#[tauri::command]
pub fn get_system_info() -> Result<SystemInfo, String> {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let os_version = get_os_version();

    Ok(SystemInfo {
        os,
        os_version,
        arch,
        hostname,
    })
}

fn get_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        get_windows_os_version().unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

#[cfg(target_os = "windows")]
fn get_windows_os_version() -> Option<String> {
    let query_value = |name: &str| -> Option<String> {
        let output = crate::platform::windows::background_command("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                "/v",
                name,
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8(output.stdout).ok()?;
        stdout.lines().find_map(|line| {
            if !line.contains(name) {
                return None;
            }
            let mut parts = line.split_whitespace();
            let key = parts.next()?;
            let _kind = parts.next()?;
            let value = parts.collect::<Vec<_>>().join(" ");
            if key.eq_ignore_ascii_case(name) && !value.trim().is_empty() {
                Some(value.trim().to_string())
            } else {
                None
            }
        })
    };

    let product_name = query_value("ProductName");
    let display_version = query_value("DisplayVersion").or_else(|| query_value("ReleaseId"));
    let current_build = query_value("CurrentBuild");

    let mut parts = Vec::new();
    if let Some(name) = product_name {
        parts.push(name);
    }
    if let Some(version) = display_version {
        parts.push(version);
    }
    if let Some(build) = current_build {
        parts.push(format!("build {build}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

#[tauri::command]
pub fn graceful_restart_for_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .ok_or_else(|| "cannot resolve app bundle path".to_string())?;
        let bundle_str = bundle.to_string_lossy().to_string();

        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 1 && open \"{}\"", bundle_str))
            .spawn()
            .map_err(|e| e.to_string())?;

        app.exit(0);
    }

    #[cfg(not(target_os = "macos"))]
    {
        app.restart();
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
pub fn check_update_installability() -> Result<UpdateInstallabilityPayload, String> {
    Ok(crate::platform::update::check_update_installability())
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows::background_command("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
