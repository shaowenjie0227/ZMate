#[cfg(target_os = "windows")]
pub fn background_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
pub fn background_command_path(program: &std::path::Path) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// 按进程映像名（如 "ZCode.exe"，大小写不敏感）判断进程是否存在。
/// 直接走 ToolHelp 快照，不派生子进程，避免每次轮询弹出控制台窗口。
#[cfg(target_os = "windows")]
pub fn process_exists(image_name: &str) -> bool {    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let target: Vec<u16> = image_name.encode_utf16().collect();

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut exists = false;
        let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
        while ok && !exists {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            if len == target.len()
                && entry.szExeFile[..len]
                    .iter()
                    .zip(target.iter())
                    .all(|(a, b)| ascii_lower(*a) == ascii_lower(*b))
            {
                exists = true;
            }
            ok = Process32NextW(snapshot, &mut entry) != 0;
        }

        let _ = CloseHandle(snapshot);
        exists
    }
}

/// 读取注册表键的默认值（REG_SZ）。
#[cfg(target_os = "windows")]
pub fn registry_default_string(key: &str) -> Option<String> {    let output = background_command("reg")
        .args(["query", key, "/ve"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).lines().find_map(|line| {
        let marker = "REG_SZ";
        let index = line.find(marker)?;
        let value = line[index + marker.len()..].trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

/// u16 版 ASCII 小写化（进程名比较用；Windows 映像名是 ASCII）。
#[cfg(target_os = "windows")]
fn ascii_lower(c: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&c) {
        c + 32
    } else {
        c
    }
}
