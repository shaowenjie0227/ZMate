//! ZCode 桌面端流量代理：读写 `~/.zcode/v2/setting.json` 的 `httpProxy`。
//!
//! 该文件是 ZCode 桌面端的 bootstrap 设置（桌面端网络栈与它拉起的 zcode
//! CLI 子进程共用），除 httpProxy 外还承载窗口尺寸、locale 等大量其他
//! 设置，因此采用 serde_json::Value 打补丁的方式只动 `httpProxy`，
//! 其余内容语义不变（未知字段全部保留）。
//!
//! httpProxy 形状（桌面端 zod schema 已验证）：可选字符串，缺省协议时
//! 桌面端自动补 `http://` 前缀；桌面端会把它同时设置为 Chromium 会话
//! 代理和子进程的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 环境变量。

use crate::core::models::{current_timestamp, CoreError, ZcodeProxyPayload};
use crate::platform::paths::ZCodePaths;
use serde::Deserialize;
use serde_json::Value;
use std::fs;

const MAX_SETTING_BACKUPS: usize = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeProxyInput {
    pub enabled: bool,
    pub port: Option<String>,
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

pub fn load_zcode_proxy(paths: &ZCodePaths) -> Result<ZcodeProxyPayload, CoreError> {
    let (setting, _exists) = read_setting(paths)?;
    let proxy_url = setting
        .get("httpProxy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let (host, port) = match &proxy_url {
        Some(url) => split_host_port(url),
        None => (None, None),
    };
    let is_local = matches!(host.as_deref(), Some("127.0.0.1") | Some("localhost"));

    Ok(ZcodeProxyPayload {
        enabled: proxy_url.is_some(),
        port,
        proxy_url,
        is_local,
        source_path: paths.desktop_setting_path.to_string_lossy().to_string(),
    })
}

/// 写入或清除 httpProxy。enabled=false 时直接移除该键（桌面端缺省即不代理）。
pub fn set_zcode_proxy(paths: &ZCodePaths, input: &ZcodeProxyInput) -> Result<ZcodeProxyPayload, CoreError> {
    let proxy_url = if input.enabled {
        let port = input.port.as_deref().unwrap_or("").trim();
        let port_num: u16 = port
            .parse()
            .map_err(|_| CoreError::InvalidData(format!("端口需为 1-65535 的数字：{port}")))?;
        if port_num == 0 {
            return Err(CoreError::InvalidData(format!("端口需为 1-65535 的数字：{port}")));
        }
        Some(format!("http://127.0.0.1:{port_num}"))
    } else {
        None
    };

    let (mut setting, exists) = read_setting(paths)?;

    backup_and_write_prep(paths, exists)?;

    match &proxy_url {
        Some(url) => setting["httpProxy"] = Value::String(url.clone()),
        None => {
            setting.as_object_mut().map(|obj| obj.remove("httpProxy"));
        }
    }
    write_setting(paths, &setting)?;

    load_zcode_proxy(paths)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

fn read_setting(paths: &ZCodePaths) -> Result<(Value, bool), CoreError> {
    match fs::read_to_string(&paths.desktop_setting_path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|e| {
                CoreError::InvalidData(format!("v2/setting.json 解析失败：{e}"))
            })?;
            Ok((value, true))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((serde_json::json!({}), false)),
        Err(e) => Err(e.into()),
    }
}

/// 拆出 (host, port)。无法解析时 host 为 None；端口非纯数字时 port 为 None。
fn split_host_port(url: &str) -> (Option<String>, Option<String>) {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // IPv6 字面量带方括号，最后一段冒号才是端口分隔
    let split_at = authority.rfind(':');
    let (host, port) = match split_at {
        Some(idx) => (&authority[..idx], &authority[idx + 1..]),
        None => (authority, ""),
    };
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let host = if host.is_empty() { None } else { Some(host.to_string()) };
    let port = if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
        Some(port.to_string())
    } else {
        None
    };
    (host, port)
}

fn backup_and_write_prep(paths: &ZCodePaths, exists: bool) -> Result<(), CoreError> {
    if exists {
        let backups_dir = paths.app_data_dir.join("backups/desktop-setting");
        fs::create_dir_all(&backups_dir)?;
        let backup_name = format!(
            "{}-{}.json",
            current_timestamp(),
            uuid::Uuid::new_v4().simple()
        );
        fs::copy(&paths.desktop_setting_path, backups_dir.join(backup_name))?;
        crate::core::mcp::prune_backups(&backups_dir, MAX_SETTING_BACKUPS);
    }
    Ok(())
}

fn write_setting(paths: &ZCodePaths, setting: &Value) -> Result<(), CoreError> {
    if let Some(parent) = paths.desktop_setting_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = paths.desktop_setting_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(setting)?)?;
    fs::rename(&tmp, &paths.desktop_setting_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_host_port;

    #[test]
    fn parses_local_proxy_url() {
        let (host, port) = split_host_port("http://127.0.0.1:7890");
        assert_eq!(host.as_deref(), Some("127.0.0.1"));
        assert_eq!(port.as_deref(), Some("7890"));
    }

    #[test]
    fn parses_schemeless_value() {
        let (host, port) = split_host_port("localhost:10809");
        assert_eq!(host.as_deref(), Some("localhost"));
        assert_eq!(port.as_deref(), Some("10809"));
    }

    #[test]
    fn handles_non_numeric_port_and_ipv6() {
        let (_, port) = split_host_port("socks5://127.0.0.1:proxy");
        assert_eq!(port, None);
        let (host, _) = split_host_port("http://[::1]:7890");
        assert_eq!(host.as_deref(), Some("::1"));
    }

    #[test]
    fn set_and_load_roundtrip_preserves_unknown_fields() {
        use super::{set_zcode_proxy, ZcodeProxyInput};
        use crate::platform::paths::ZCodePaths;

        let dir = std::env::temp_dir().join(format!("zmate-proxy-test-{}", std::process::id()));
        let zcode_home = dir.join(".zcode");
        std::fs::create_dir_all(zcode_home.join("v2")).unwrap();
        std::fs::write(
            zcode_home.join("v2/setting.json"),
            r#"{"locale":"zh-CN","unknownKey":{"a":1}}"#,
        )
        .unwrap();
        let paths = ZCodePaths::from_home(zcode_home.clone());

        let out = set_zcode_proxy(
            &paths,
            &ZcodeProxyInput { enabled: true, port: Some("7890".into()) },
        )
        .unwrap();
        assert!(out.enabled);
        assert_eq!(out.port.as_deref(), Some("7890"));
        assert_eq!(out.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
        assert!(out.is_local);

        let raw = std::fs::read_to_string(zcode_home.join("v2/setting.json")).unwrap();
        assert!(raw.contains("zh-CN"), "既有字段必须保留");
        assert!(raw.contains("unknownKey"), "未知字段必须保留");
        assert!(raw.contains("http://127.0.0.1:7890"));

        let backups_dir = zcode_home.join("zmate/backups/desktop-setting");
        assert_eq!(std::fs::read_dir(&backups_dir).unwrap().count(), 1, "写入前应有备份");

        let out = set_zcode_proxy(
            &paths,
            &ZcodeProxyInput { enabled: false, port: None },
        )
        .unwrap();
        assert!(!out.enabled);
        assert_eq!(out.proxy_url, None);
        let raw = std::fs::read_to_string(zcode_home.join("v2/setting.json")).unwrap();
        assert!(!raw.contains("httpProxy"), "关闭后键应被移除");
        assert!(raw.contains("zh-CN"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_port() {
        use super::{set_zcode_proxy, ZcodeProxyInput};
        use crate::core::models::CoreError;
        use crate::platform::paths::ZCodePaths;

        let dir = std::env::temp_dir().join(format!("zmate-proxy-invalid-{}", std::process::id()));
        let zcode_home = dir.join(".zcode");
        std::fs::create_dir_all(zcode_home.join("v2")).unwrap();
        let paths = ZCodePaths::from_home(zcode_home);

        let err = set_zcode_proxy(
            &paths,
            &ZcodeProxyInput { enabled: true, port: Some("99999".into()) },
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::InvalidData(_)));

        std::fs::remove_dir_all(dir).unwrap();
    }
}
