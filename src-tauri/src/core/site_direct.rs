//! IP 直连站点：域名不可用时，把站点入口切换到备用直连 IP。
//!
//! 站点有三个入口：主域名 + 两台直连 IP。开启直连时对三者各发一次
//! `GET /api/status` 测活（能收到任意 HTTP 响应即视为可达），按
//! 域名 > 主 IP > 备 IP 的优先级选定入口，然后把 settings.json 的
//! `site_base_url` 与 provider_config.json 中所有命中旧入口的字符串
//! 统一替换为新入口（保留路径后缀，如 `/v1`）。
//!
//! provider_config.json 仍按「Value 打补丁保留未知字段 + 写前备份 +
//! 原子写」处理；关闭直连即把入口恢复回主域名。

use crate::core::models::{current_timestamp, CoreError};
use crate::core::settings;
use crate::platform::paths::ZCodePaths;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::time::{Duration, Instant};

pub const ORIGIN_DOMAIN: &str = "https://aispot.swj0227.icu";
pub const ORIGIN_IP_PRIMARY: &str = "http://38.207.166.83";
pub const ORIGIN_IP_FALLBACK: &str = "http://149.88.72.47";

/// 测活优先级：域名通就继续用域名；域名不通时主 IP 优先于备 IP。
pub const ORIGINS_BY_PRIORITY: [&str; 3] = [ORIGIN_DOMAIN, ORIGIN_IP_PRIMARY, ORIGIN_IP_FALLBACK];

const PING_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const PING_TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PROVIDER_BACKUPS: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDirectPing {
    pub label: String,
    pub origin: String,
    pub reachable: bool,
    pub status_code: Option<u16>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDirectStatus {
    /// settings.json 的站点地址当前是否指向某个直连 IP。
    pub direct_active: bool,
    /// 当前命中的已知入口（都不命中时为 null）。
    pub current_origin: Option<String>,
    pub settings_base_url: String,
    /// provider_config.json 里入口仍指向已知地址的供应商条数。
    pub provider_matches: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDirectApplyReport {
    pub target_origin: String,
    pub settings_updated: bool,
    pub providers_updated: usize,
    pub backup_path: Option<String>,
    pub effective_base_url: String,
}

// ---------------------------------------------------------------------------
// 测活
// ---------------------------------------------------------------------------

/// 对单个入口发 `GET /api/status`：收到任意 HTTP 响应（含 4xx/5xx）即视为可达。
pub fn ping_target(label: &str, origin: &str) -> SiteDirectPing {
    let unreachable = |error: String| SiteDirectPing {
        label: label.to_string(),
        origin: origin.to_string(),
        reachable: false,
        status_code: None,
        latency_ms: None,
        error: Some(error),
    };

    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(PING_CONNECT_TIMEOUT)
        .timeout(PING_TOTAL_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(e) => return unreachable(format!("HTTP 客户端创建失败：{e}")),
    };

    let url = format!("{}/api/status", origin.trim_end_matches('/'));
    let started = Instant::now();
    match client.get(&url).send() {
        Ok(response) => SiteDirectPing {
            label: label.to_string(),
            origin: origin.to_string(),
            reachable: true,
            status_code: Some(response.status().as_u16()),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            error: None,
        },
        Err(e) => unreachable(format!("{e}")),
    }
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

pub fn load_status(paths: &ZCodePaths) -> Result<SiteDirectStatus, CoreError> {
    let settings = settings::load_settings(paths);
    // 已存连接的地址优先；未连接（base_url 为空）时回落到用户最近选择的直连入口，
    // 让登录页 / 向导的站点地址默认值在断开后仍跟随切换结果
    let current_origin = known_origin_of(&settings.site_base_url).or_else(|| {
        settings
            .site_direct_origin
            .clone()
            .filter(|origin| ORIGINS_BY_PRIORITY.contains(&origin.as_str()))
    });
    let provider_matches = count_provider_matches(paths);

    Ok(SiteDirectStatus {
        direct_active: matches!(
            current_origin.as_deref(),
            Some(ORIGIN_IP_PRIMARY) | Some(ORIGIN_IP_FALLBACK)
        ),
        current_origin,
        settings_base_url: settings.site_base_url,
        provider_matches,
    })
}

/// 已知入口里哪个是 base_url 的前缀（最长匹配，避免主备 IP 互为前缀的误判）。
fn known_origin_of(base_url: &str) -> Option<String> {
    ORIGINS_BY_PRIORITY
        .iter()
        .filter(|origin| base_url.starts_with(**origin))
        .max_by_key(|origin| origin.len())
        .map(|origin| origin.to_string())
}

fn count_provider_matches(paths: &ZCodePaths) -> usize {
    read_provider_config(paths)
        .map(|config| {
            config
                .pointer("/config/providerConfigRules/providerRules")
                .and_then(Value::as_array)
                .map(|rules| {
                    rules
                        .iter()
                        .filter(|rule| {
                            rule.pointer("/config/api/baseUrl")
                                .and_then(Value::as_str)
                                .is_some_and(|url| known_origin_of(url).is_some())
                        })
                        .count()
                })
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 切换
// ---------------------------------------------------------------------------

/// 把站点入口统一切到 target：settings.json 的 site_base_url 与
/// provider_config.json 里所有命中其他已知入口的字符串都替换为 target。
pub fn apply_origin(paths: &ZCodePaths, target_origin: &str) -> Result<SiteDirectApplyReport, CoreError> {
    if !ORIGINS_BY_PRIORITY.contains(&target_origin) {
        return Err(CoreError::InvalidData(format!(
            "未知站点入口：{target_origin}"
        )));
    }

    // 1. settings.json：AppSettings 是面板自有的小结构，直接改字段整写。
    //    除替换已有 base_url 外，还记录本次选择的入口（site_direct_origin）——
    //    未连接时 base_url 为空，登录页/向导的默认地址要靠它跟随直连切换。
    let mut settings = settings::load_settings(paths);
    let mut settings_updated = false;
    for origin in ORIGINS_BY_PRIORITY {
        if origin != target_origin && settings.site_base_url.contains(origin) {
            settings.site_base_url = settings.site_base_url.replace(origin, target_origin);
            settings_updated = true;
        }
    }
    if settings.site_direct_origin.as_deref() != Some(target_origin) {
        settings.site_direct_origin = Some(target_origin.to_string());
        settings_updated = true;
    }
    if settings_updated {
        settings::save_settings(paths, &settings)?;
    }

    // 2. provider_config.json：全树字符串替换（baseUrl 及未来可能出现的
    //    其他地址字段都覆盖），有变更才备份+写回
    let mut config = match read_provider_config(paths) {
        Some(config) => config,
        None => {
            return Ok(SiteDirectApplyReport {
                target_origin: target_origin.to_string(),
                settings_updated,
                providers_updated: 0,
                backup_path: None,
                effective_base_url: settings.site_base_url,
            })
        }
    };
    let providers_updated = replace_origins_in_value(&mut config, target_origin);
    let mut backup_path = None;
    if providers_updated > 0 {
        backup_path = backup_provider_config(paths)?;
        write_provider_config(paths, &config)?;
    }

    Ok(SiteDirectApplyReport {
        target_origin: target_origin.to_string(),
        settings_updated,
        providers_updated,
        backup_path,
        effective_base_url: settings.site_base_url,
    })
}

/// 递归替换 Value 里所有字符串值中命中的旧入口；返回发生变更的 provider 条数。
fn replace_origins_in_value(value: &mut Value, target_origin: &str) -> usize {
    let mut providers_updated = 0;
    match value {
        Value::Object(map) => {
            let is_provider_rule = map.get("providerId").is_some() && map.get("config").is_some();
            if is_provider_rule {
                let before = serde_json::to_string(map).unwrap_or_default();
                for (_, child) in map.iter_mut() {
                    replace_origins_in_value(child, target_origin);
                }
                let after = serde_json::to_string(map).unwrap_or_default();
                if before != after {
                    providers_updated += 1;
                }
            } else {
                for (_, child) in map.iter_mut() {
                    providers_updated += replace_origins_in_value(child, target_origin);
                }
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                providers_updated += replace_origins_in_value(item, target_origin);
            }
        }
        Value::String(text) => {
            let mut replaced = text.clone();
            for origin in ORIGINS_BY_PRIORITY {
                if origin != target_origin {
                    replaced = replaced.replace(origin, target_origin);
                }
            }
            *text = replaced;
        }
        _ => {}
    }
    providers_updated
}

// ---------------------------------------------------------------------------
// provider_config.json 读写（与 providers.rs 同一套备份/原子写约定）
// ---------------------------------------------------------------------------

fn read_provider_config(paths: &ZCodePaths) -> Option<Value> {
    let text = fs::read_to_string(&paths.provider_config_path).ok()?;
    serde_json::from_str(&text).ok()
}

fn backup_provider_config(paths: &ZCodePaths) -> Result<Option<String>, CoreError> {
    if !paths.provider_config_path.exists() {
        return Ok(None);
    }
    let backups_dir = paths.provider_config_backups_dir.clone();
    fs::create_dir_all(&backups_dir)?;
    let name = format!(
        "{}-{}.json",
        current_timestamp(),
        uuid::Uuid::new_v4().simple()
    );
    let target = backups_dir.join(&name);
    fs::copy(&paths.provider_config_path, &target)?;
    prune_backups(&backups_dir, MAX_PROVIDER_BACKUPS);
    Ok(Some(target.to_string_lossy().to_string()))
}

fn prune_backups(dir: &std::path::Path, keep: usize) {
    let mut backups: Vec<_> = match fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return,
    };
    backups.sort();
    while backups.len() > keep {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
}

fn write_provider_config(paths: &ZCodePaths, config: &Value) -> Result<(), CoreError> {
    if let Some(parent) = paths.provider_config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = paths.provider_config_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(config)?)?;
    fs::rename(&tmp, &paths.provider_config_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_origin, load_status, ORIGIN_DOMAIN, ORIGIN_IP_FALLBACK, ORIGIN_IP_PRIMARY};
    use crate::platform::paths::ZCodePaths;
    use serde_json::json;

    fn temp_home(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zmate-site-direct-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".zcode/v2")).unwrap();
        std::fs::create_dir_all(dir.join(".zcode/zmate")).unwrap();
        dir
    }

    fn write_settings(home: &std::path::Path, base_url: &str) {
        std::fs::write(
            home.join(".zcode/zmate/settings.json"),
            json!({
                "checkZcodeRunning": true,
                "siteBaseUrl": base_url,
                "siteAccessToken": "sk-test",
                "siteUserId": 1
            })
            .to_string(),
        )
        .unwrap();
    }

    fn sample_provider_config() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "config": {
                "providerOrder": ["crm", "local"],
                "providerConfigRules": {
                    "providerRules": [
                        {
                            "providerId": "crm",
                            "providerName": "crm",
                            "config": {
                                "access": { "type": "api-key", "apiKey": "sk-1" },
                                "api": { "type": "openai-responses", "baseUrl": "https://aispot.swj0227.icu/v1" }
                            }
                        },
                        {
                            "providerId": "local",
                            "providerName": "local",
                            "config": {
                                "access": { "type": "api-key", "apiKey": "sk-2" },
                                "api": { "type": "openai-chat-completions", "baseUrl": "http://127.0.0.1:9999/v1" }
                            }
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn apply_switches_settings_and_providers_preserving_unknown_fields() {
        let dir = temp_home("switch");
        let home = dir.join(".zcode");
        write_settings(&dir, ORIGIN_DOMAIN);
        std::fs::write(
            home.join("v2/provider_config.json"),
            sample_provider_config().to_string(),
        )
        .unwrap();
        let paths = ZCodePaths::from_home(home.clone());

        let report = apply_origin(&paths, ORIGIN_IP_PRIMARY).unwrap();
        assert!(report.settings_updated);
        assert_eq!(report.providers_updated, 1);
        assert!(report.backup_path.is_some(), "写入前应有备份");

        let raw = std::fs::read_to_string(home.join("v2/provider_config.json")).unwrap();
        assert!(raw.contains("http://38.207.166.83/v1"), "路径后缀 /v1 必须保留");
        assert!(!raw.contains(ORIGIN_DOMAIN), "旧域名必须被替换");
        assert!(raw.contains("127.0.0.1:9999"), "无关供应商不得被动");
        assert!(raw.contains("\"providerOrder\""), "未知字段必须保留");

        let settings_raw = std::fs::read_to_string(dir.join(".zcode/zmate/settings.json")).unwrap();
        assert!(settings_raw.contains("sk-test"), "令牌不得丢失");

        let status = load_status(&paths).unwrap();
        assert!(status.direct_active);
        assert_eq!(status.current_origin.as_deref(), Some(ORIGIN_IP_PRIMARY));
        assert_eq!(status.provider_matches, 1);

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn apply_restores_domain_from_ip() {
        let dir = temp_home("restore");
        let home = dir.join(".zcode");
        write_settings(&dir, ORIGIN_IP_PRIMARY);
        std::fs::write(
            home.join("v2/provider_config.json"),
            sample_provider_config().to_string(),
        )
        .unwrap();
        let paths = ZCodePaths::from_home(home.clone());

        let report = apply_origin(&paths, ORIGIN_DOMAIN).unwrap();
        assert!(report.settings_updated);
        assert_eq!(report.providers_updated, 0, "示例配置里只有域名入口,恢复时 IP 是目标,无替换");

        let status = load_status(&paths).unwrap();
        assert!(!status.direct_active);
        assert_eq!(status.current_origin.as_deref(), Some(ORIGIN_DOMAIN));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn apply_replaces_stale_ip_with_new_ip() {
        let dir = temp_home("stale");
        let home = dir.join(".zcode");
        write_settings(&dir, ORIGIN_IP_PRIMARY);
        std::fs::write(
            home.join("v2/provider_config.json"),
            sample_provider_config().to_string(),
        )
        .unwrap();
        let paths = ZCodePaths::from_home(home.clone());

        let report = apply_origin(&paths, ORIGIN_IP_FALLBACK).unwrap();
        assert!(report.settings_updated);
        assert_eq!(report.providers_updated, 1, "示例配置里的域名规则应一并改写为备 IP");
        let status = load_status(&paths).unwrap();
        assert_eq!(status.current_origin.as_deref(), Some(ORIGIN_IP_FALLBACK));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn apply_rejects_unknown_target() {
        let dir = temp_home("reject");
        let home = dir.join(".zcode");
        write_settings(&dir, ORIGIN_DOMAIN);
        let paths = ZCodePaths::from_home(home);

        let err = apply_origin(&paths, "https://evil.example.com").unwrap_err();
        assert!(err.to_string().contains("未知站点入口"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn apply_records_origin_preference_while_disconnected() {
        let dir = temp_home("disconnected");
        let home = dir.join(".zcode");
        // 未连接：settings.json 里没有站点地址与令牌
        std::fs::write(
            dir.join(".zcode/zmate/settings.json"),
            json!({ "checkZcodeRunning": true }).to_string(),
        )
        .unwrap();
        let paths = ZCodePaths::from_home(home);

        let report = apply_origin(&paths, ORIGIN_IP_PRIMARY).unwrap();
        assert!(report.settings_updated);
        assert_eq!(report.effective_base_url, "", "未连接不得凭空生成连接地址");

        // 断开状态下状态查询也能给出最近选择的入口（登录默认地址的数据源）
        let status = load_status(&paths).unwrap();
        assert!(status.direct_active);
        assert_eq!(status.current_origin.as_deref(), Some(ORIGIN_IP_PRIMARY));

        // 换回域名后偏好同步更新
        apply_origin(&paths, ORIGIN_DOMAIN).unwrap();
        let status = load_status(&paths).unwrap();
        assert!(!status.direct_active);
        assert_eq!(status.current_origin.as_deref(), Some(ORIGIN_DOMAIN));

        std::fs::remove_dir_all(dir).unwrap();
    }
}
