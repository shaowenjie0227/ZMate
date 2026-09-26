//! ZCode MCP 管理：读写 `~/.zcode/cli/config.json` 的 `mcp.servers`。
//!
//! 该文件是 ZCode CLI 的用户配置，还承载 hooks / plugins 等其他配置，
//! 因此采用 serde_json::Value 打补丁的方式只动 `mcp.servers`，其余内容
//! 语义不变（未知字段全部保留）。
//!
//! servers 形状（引擎 zod schema，已验证）：record<名称, 条目>：
//! - stdio:  { "type": "stdio", "command": string, "args"?: string[], "cwd"?: string, "env"?: record<string,string>, "enabled"?: bool, "timeoutMs"?: number }
//! - http/sse: { "type": "http"|"sse", "url": string, "headers"?: record<string,string>, "enabled"?: bool, ... }

use crate::core::models::{
    current_timestamp, CoreError, McpServerListPayload, McpServerMutationPayload,
    McpServerRemovePayload, McpServerSummary, McpTransport,
};
use crate::platform::paths::ZCodePaths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub transport: McpTransport,
    pub enabled: bool,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
}

const MAX_CONFIG_BACKUPS: usize = 10;

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

pub fn load_mcp_servers(paths: &ZCodePaths) -> Result<McpServerListPayload, CoreError> {
    let (config, exists) = read_config(paths)?;
    let source_path = paths.cli_config_path.to_string_lossy().to_string();

    let mut items = Vec::new();
    if let Some(servers) = config.pointer("/mcp/servers").and_then(Value::as_object) {
        for (name, entry) in servers {
            items.push(entry_to_summary(name, entry, &source_path));
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(McpServerListPayload {
        total: items.len() as i32,
        items,
        source_path: if exists {
            source_path
        } else {
            format!("{source_path}（尚未创建，保存时自动创建）")
        },
        last_scan_at: current_timestamp(),
    })
}

fn read_config(paths: &ZCodePaths) -> Result<(Value, bool), CoreError> {
    match fs::read_to_string(&paths.cli_config_path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| CoreError::InvalidData(format!("cli/config.json 解析失败：{e}")))?;
            Ok((value, true))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((json!({}), false)),
        Err(e) => Err(e.into()),
    }
}

fn entry_to_summary(name: &str, entry: &Value, source_path: &str) -> McpServerSummary {
    let transport = match entry.get("type").and_then(Value::as_str) {
        Some("stdio") => McpTransport::Stdio,
        Some("http") => McpTransport::Http,
        Some("sse") => McpTransport::Sse,
        _ => McpTransport::Unknown,
    };
    McpServerSummary {
        name: name.to_string(),
        transport,
        enabled: entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        source_path: source_path.to_string(),
        command: entry
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        args: entry
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        url: entry.get("url").and_then(Value::as_str).map(str::to_string),
        headers: record_to_map(entry.get("headers")),
        environment: record_to_map(entry.get("env")),
    }
}

fn record_to_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 写入（全部走「读 Value → 打补丁 → 备份 → 原子写」）
// ---------------------------------------------------------------------------

pub fn upsert_mcp_server(
    paths: &ZCodePaths,
    input: McpServerInput,
) -> Result<McpServerMutationPayload, CoreError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(CoreError::InvalidData("MCP 名称不能为空".into()));
    }
    match input.transport {
        McpTransport::Stdio => {
            if input.command.as_deref().unwrap_or("").trim().is_empty() {
                return Err(CoreError::InvalidData("stdio 类型必须填写 command".into()));
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            if input.url.as_deref().unwrap_or("").trim().is_empty() {
                return Err(CoreError::InvalidData("http/sse 类型必须填写 url".into()));
            }
        }
        McpTransport::Unknown => {
            return Err(CoreError::InvalidData("未知的 transport 类型".into()));
        }
    }

    let (mut config, _) = read_config(paths)?;

    let (summary, total) = {
        let servers = ensure_servers(&mut config)?;
        let existing = servers.get(&name).cloned();
        let new_type = transport_type_str(&input.transport);

        // 类型不变时保留未知字段（oauth / timeoutMs / cwd 等）；类型切换则整体重建。
        let mut entry = match &existing {
            Some(prev) if prev.get("type").and_then(Value::as_str) == Some(new_type) => prev.clone(),
            _ => json!({ "type": new_type }),
        };

        entry["enabled"] = Value::Bool(input.enabled);
        match input.transport {
            McpTransport::Stdio => {
                entry["command"] = Value::String(input.command.clone().unwrap_or_default());
                apply_optional(&mut entry, "args", string_slice(&input.args));
                apply_optional(&mut entry, "env", map_value(&input.environment));
            }
            McpTransport::Http | McpTransport::Sse => {
                entry["url"] = Value::String(input.url.clone().unwrap_or_default());
                apply_optional(&mut entry, "headers", map_value(&input.headers));
            }
            McpTransport::Unknown => unreachable!("已在入口校验"),
        }

        servers.insert(name.clone(), entry);
        let total = servers.len() as i32;
        let summary = entry_to_summary(
            &name,
            servers.get(&name).expect("刚写入"),
            &paths.cli_config_path.to_string_lossy(),
        );
        (summary, total)
    };
    backup_and_write(paths, &config)?;

    Ok(McpServerMutationPayload {
        server: summary,
        total,
        source_path: paths.cli_config_path.to_string_lossy().to_string(),
    })
}

pub fn set_mcp_server_enabled(
    paths: &ZCodePaths,
    name: &str,
    enabled: bool,
) -> Result<McpServerMutationPayload, CoreError> {
    let (mut config, _) = read_config(paths)?;

    let (summary, total) = {
        let servers = ensure_servers(&mut config)?;
        let entry = servers
            .get_mut(name)
            .ok_or_else(|| CoreError::NotFound(format!("MCP server 不存在：{name}")))?;
        entry["enabled"] = Value::Bool(enabled);
        let total = servers.len() as i32;
        let summary = entry_to_summary(
            name,
            servers.get(name).expect("刚写入"),
            &paths.cli_config_path.to_string_lossy(),
        );
        (summary, total)
    };
    backup_and_write(paths, &config)?;

    Ok(McpServerMutationPayload {
        server: summary,
        total,
        source_path: paths.cli_config_path.to_string_lossy().to_string(),
    })
}

pub fn remove_mcp_server(
    paths: &ZCodePaths,
    name: &str,
) -> Result<McpServerRemovePayload, CoreError> {
    let (mut config, _) = read_config(paths)?;
    let servers = ensure_servers(&mut config)?;
    if servers.remove(name).is_none() {
        return Err(CoreError::NotFound(format!("MCP server 不存在：{name}")));
    }
    let total = servers.len() as i32;
    backup_and_write(paths, &config)?;
    Ok(McpServerRemovePayload {
        removed_name: name.to_string(),
        total,
        source_path: paths.cli_config_path.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn ensure_servers(config: &mut Value) -> Result<&mut Map<String, Value>, CoreError> {
    if config.get("mcp").is_none() {
        config["mcp"] = json!({});
    }
    if !config["mcp"].is_object() {
        return Err(CoreError::InvalidData(
            "cli/config.json 的 mcp 字段不是对象，拒绝修改".into(),
        ));
    }
    if config["mcp"].get("servers").is_none() {
        config["mcp"]["servers"] = json!({});
    }
    if !config["mcp"]["servers"].is_object() {
        return Err(CoreError::InvalidData(
            "cli/config.json 的 mcp.servers 不是对象，拒绝修改".into(),
        ));
    }
    Ok(config["mcp"]["servers"]
        .as_object_mut()
        .expect("已校验为对象"))
}

fn transport_type_str(transport: &McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
        McpTransport::Unknown => "unknown",
    }
}

/// 空数组/空对象不写入，保持 schema 简洁；已存在的键若新值为空则移除。
fn apply_optional(entry: &mut Value, key: &str, value: Option<Value>) {
    match value {
        Some(v) if !is_empty_value(&v) => entry[key] = v,
        _ => {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove(key);
            }
        }
    }
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

fn string_slice(items: &[String]) -> Option<Value> {
    if items.is_empty() {
        None
    } else {
        Some(json!(items))
    }
}

fn map_value(map: &HashMap<String, String>) -> Option<Value> {
    if map.is_empty() {
        None
    } else {
        Some(json!(map))
    }
}

fn backup_and_write(paths: &ZCodePaths, config: &Value) -> Result<(), CoreError> {
    if paths.cli_config_path.exists() {
        let backups_dir = paths.app_data_dir.join("backups/cli-config");
        fs::create_dir_all(&backups_dir)?;
        let backup_name = format!(
            "{}-{}.json",
            current_timestamp(),
            uuid::Uuid::new_v4().simple()
        );
        fs::copy(&paths.cli_config_path, backups_dir.join(backup_name))?;
        prune_backups(&backups_dir, MAX_CONFIG_BACKUPS);
    }

    if let Some(parent) = paths.cli_config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = paths.cli_config_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(config)?)?;
    fs::rename(&tmp, &paths.cli_config_path)?;
    Ok(())
}

pub(crate) fn prune_backups(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|e| e.file_name());
    let excess = files.len() - keep;
    for entry in files.into_iter().take(excess) {
        let _ = fs::remove_file(entry.path());
    }
}
