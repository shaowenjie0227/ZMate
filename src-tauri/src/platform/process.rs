//! ZCode 桌面端进程管理：运行检测 / 优雅退出 / 启动 / 重启。
//!
//! macOS 用 osascript + pgrep（Electron 主进程名为 ZCode），
//! Windows 用 ToolHelp 快照检测 + taskkill 退出 + 常见安装路径启动，
//! Linux 为尽力支持。

use crate::core::models::CoreError;
use std::time::{Duration, Instant};

#[cfg(not(target_os = "windows"))]
const ZCODE_PROCESS_NAME: &str = "ZCode";
#[cfg(target_os = "windows")]
const ZCODE_PROCESS_IMAGE: &str = "ZCode.exe";

pub fn is_zcode_running() -> bool {
    // 注意：不能用 pgrep——Electron 主进程的参数区被改写后，
    // macOS 的 pgrep（含 -f）匹配不到它（实测 PID 21795 现象）。
    // ps 的 comm 输出稳定可见，这里精确匹配进程名。
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows::process_exists(ZCODE_PROCESS_IMAGE)
    }
    #[cfg(not(target_os = "windows"))]
    {
        match std::process::Command::new("ps").args(["-axo", "comm="]).output() {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim() == ZCODE_PROCESS_NAME),
            Err(_) => false,
        }
    }
}

#[cfg(target_os = "macos")]
pub fn quit_zcode_gracefully(timeout: Duration) -> Result<(), CoreError> {
    if !is_zcode_running() {
        return Ok(());
    }
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!("tell application \"{ZCODE_PROCESS_NAME}\" to quit"))
        .output()
        .map_err(|e| CoreError::OperationFailed(format!("osascript 执行失败：{e}")))?;

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_zcode_running() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = std::process::Command::new("killall")
        .arg("-9")
        .arg(ZCODE_PROCESS_NAME)
        .output();
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn quit_zcode_gracefully(timeout: Duration) -> Result<(), CoreError> {
    if !is_zcode_running() {
        return Ok(());
    }
    // taskkill 不带 /F 会向窗口投递 WM_CLOSE，让 Electron 走正常退出流程。
    let _ = crate::platform::windows::background_command("taskkill")
        .args(["/IM", ZCODE_PROCESS_IMAGE])
        .output();

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !is_zcode_running() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    // 宽限期内没退干净（如残留的 GPU/渲染子进程），强制结束。
    let _ = crate::platform::windows::background_command("taskkill")
        .args(["/F", "/IM", ZCODE_PROCESS_IMAGE])
        .output();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if !is_zcode_running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn launch_zcode() -> Result<(), CoreError> {
    let status = std::process::Command::new("open")
        .arg("-a")
        .arg(ZCODE_PROCESS_NAME)
        .status()
        .map_err(|e| CoreError::OperationFailed(format!("open 执行失败：{e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(CoreError::OperationFailed(
            "启动 ZCode 失败：请确认应用已安装且名为 ZCode".into(),
        ))
    }
}

#[cfg(target_os = "windows")]
pub fn launch_zcode() -> Result<(), CoreError> {
    let exe = find_zcode_exe().ok_or_else(|| {
        CoreError::OperationFailed(
            "未找到 ZCode.exe：请确认 ZCode 桌面端已安装".into(),
        )
    })?;
    crate::platform::windows::background_command_path(&exe)
        .spawn()
        .map_err(|e| CoreError::OperationFailed(format!("启动 ZCode 失败：{e}")))?;
    Ok(())
}

/// ZCode 桌面端在 Windows 上的安装位置不固定：机器级安装在
/// `%ProgramFiles%\ZCode`，用户级安装在 `%LOCALAPPDATA%\Programs\ZCode`。
/// 先按常见路径查找，再用注册表 App Paths 兜底。
#[cfg(target_os = "windows")]
fn find_zcode_exe() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            std::path::PathBuf::from(program_files)
                .join("ZCode")
                .join("ZCode.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            std::path::PathBuf::from(local_app_data)
                .join("Programs")
                .join("ZCode")
                .join("ZCode.exe"),
        );
    }
    if let Some(path) = candidates.into_iter().find(|c| c.is_file()) {
        return Some(path);
    }

    for key in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe",
    ] {
        if let Some(value) = crate::platform::windows::registry_default_string(key) {
            let path = std::path::PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn restart_zcode() -> Result<(), CoreError> {
    quit_zcode_gracefully(Duration::from_secs(8))?;
    std::thread::sleep(Duration::from_millis(500));
    launch_zcode()
}
