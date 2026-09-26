//! ZCode 桌面端进程管理：运行检测 / 优雅退出 / 启动 / 重启。
//!
//! macOS 用 osascript + pgrep（Electron 主进程名为 ZCode），
//! Windows / Linux 为尽力支持。

use crate::core::models::CoreError;
use std::time::{Duration, Instant};

const ZCODE_PROCESS_NAME: &str = "ZCode";

pub fn is_zcode_running() -> bool {
    // 注意：不能用 pgrep——Electron 主进程的参数区被改写后，
    // macOS 的 pgrep（含 -f）匹配不到它（实测 PID 21795 现象）。
    // ps 的 comm 输出稳定可见，这里精确匹配进程名。
    #[cfg(target_os = "windows")]
    {
        match std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq ZCode.exe", "/NH"])
            .output()
        {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .to_lowercase()
                .contains("zcode.exe"),
            Err(_) => false,
        }
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

#[cfg(not(target_os = "macos"))]
pub fn quit_zcode_gracefully(_timeout: Duration) -> Result<(), CoreError> {
    Err(CoreError::OperationFailed(
        "当前平台暂不支持自动退出 ZCode，请手动退出后重试".into(),
    ))
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

#[cfg(not(target_os = "macos"))]
pub fn launch_zcode() -> Result<(), CoreError> {
    Err(CoreError::OperationFailed(
        "当前平台暂不支持自动启动 ZCode，请手动启动".into(),
    ))
}

pub fn restart_zcode() -> Result<(), CoreError> {
    quit_zcode_gracefully(Duration::from_secs(8))?;
    std::thread::sleep(Duration::from_millis(500));
    launch_zcode()
}
