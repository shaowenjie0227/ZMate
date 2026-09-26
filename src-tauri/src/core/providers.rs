//! ZCode 自定义模型供应商管理：读写 `~/.zcode/v2/provider_config.json`。
//!
//! 该文件可能包含我们不认识的字段（如 overlay 元数据、manualProviderModelRules、
//! 模板下发的 optionSpecs 等），因此全部采用 serde_json::Value 打补丁的方式，
//! 只动已知路径，其余内容原样保留。写入前先备份，再原子写。

use crate::core::models::{current_timestamp, CoreError, CoreWarning};
use crate::platform::paths::ZCodePaths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApiType {
    #[default]
    OpenaiResponses,
    OpenaiChatCompletions,
    AnthropicMessages,
}

impl ProviderApiType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::OpenaiResponses => "openai-responses",
            Self::OpenaiChatCompletions => "openai-chat-completions",
            Self::AnthropicMessages => "anthropic-messages",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningLevelSpec {
    pub values: Vec<String>,
    pub map: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderModelInput {
    pub model_id: String,
    pub context_window: Option<i64>,
    pub supports_image: Option<bool>,
    pub reasoning_levels: Option<Vec<String>>,
    pub reasoning_map: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderUpsertInput {
    pub provider_id: Option<String>,
    pub provider_name: String,
    pub api_type: ProviderApiType,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<ProviderModelInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSummary {
    pub model_id: String,
    pub enabled: bool,
    pub context_window: Option<i64>,
    pub supports_image: Option<bool>,
    pub reasoning: Option<ReasoningLevelSpec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub provider_id: String,
    pub provider_name: String,
    pub api_type: ProviderApiType,
    pub base_url: String,
    pub model_count: usize,
    pub enabled: bool,
    /// 仅表示是否已配置 Key，绝不回传 Key 本身。
    pub api_key_set: bool,
    pub models: Vec<ProviderModelSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatePayload {
    pub items: Vec<ProviderSummary>,
    pub provider_order: Vec<String>,
    pub source_path: String,
    pub config_exists: bool,
    pub last_scan_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsPayload {
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectivityPayload {
    pub reachable: bool,
    pub status_code: Option<i32>,
    pub message: String,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMutationPayload {
    pub provider: ProviderSummary,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRemovePayload {
    pub removed_provider_id: String,
    pub backup_path: Option<String>,
}

const MAX_CONFIG_BACKUPS: usize = 10;

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

fn read_config(paths: &ZCodePaths) -> Result<(Value, bool), CoreError> {
    match fs::read_to_string(&paths.provider_config_path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|e| {
                CoreError::InvalidData(format!("provider_config.json 解析失败：{e}"))
            })?;
            Ok((value, true))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((json!({}), false)),
        Err(e) => Err(e.into()),
    }
}

pub fn load_provider_state(paths: &ZCodePaths) -> Result<ProviderStatePayload, CoreError> {
    let (config, exists) = read_config(paths)?;
    let source_path = paths.provider_config_path.to_string_lossy().to_string();

    let provider_order: Vec<String> = config
        .pointer("/config/providerOrder")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut items = Vec::new();
    if let Some(rules) = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
    {
        for rule in rules {
            if let Some(summary) = rule_to_summary(rule, &config) {
                items.push(summary);
            }
        }
    }
    // 按 providerOrder 排序，未知供应商排后面
    items.sort_by(|a, b| {
        let pos = |id: &str| provider_order.iter().position(|x| x == id).unwrap_or(usize::MAX);
        pos(&a.provider_id).cmp(&pos(&b.provider_id))
    });

    Ok(ProviderStatePayload {
        items,
        provider_order,
        source_path,
        config_exists: exists,
        last_scan_at: current_timestamp(),
    })
}

fn rule_to_summary(rule: &Value, config: &Value) -> Option<ProviderSummary> {
    let provider_id = rule.get("providerId").and_then(Value::as_str)?.to_string();
    let provider_name = rule
        .get("providerName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cfg = rule.get("config")?;
    let api = cfg.get("api")?;
    let api_type = match api.get("type").and_then(Value::as_str) {
        Some("openai-responses") => ProviderApiType::OpenaiResponses,
        Some("openai-chat-completions") => ProviderApiType::OpenaiChatCompletions,
        Some("anthropic-messages") => ProviderApiType::AnthropicMessages,
        _ => return None,
    };
    let base_url = api
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let api_key_set = cfg
        .pointer("/access/apiKey")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let models = model_summaries_for(&provider_id, config);
    let model_count = models.len();
    let enabled = model_count > 0 && models.iter().all(|m| m.enabled);

    Some(ProviderSummary {
        provider_id,
        provider_name,
        api_type,
        base_url,
        model_count,
        enabled,
        api_key_set,
        models,
    })
}

fn model_summaries_for(provider_id: &str, config: &Value) -> Vec<ProviderModelSummary> {
    let mut items = Vec::new();
    if let Some(rules) = config
        .pointer("/config/modelConfigRules/providerModelRules")
        .and_then(Value::as_array)
    {
        for rule in rules {
            if rule.get("providerId").and_then(Value::as_str) != Some(provider_id) {
                continue;
            }
            let model_id = match rule.get("modelId").and_then(Value::as_str) {
                Some(id) => id.to_string(),
                None => continue,
            };
            let cfg = rule.get("config");
            let properties = cfg.and_then(|c| c.get("properties"));
            let context_window = properties
                .and_then(|p| p.get("contextWindow"))
                .and_then(Value::as_i64);
            let supports_image = properties
                .and_then(|p| p.pointer("/inputFormat/supportsImage"))
                .and_then(Value::as_bool);
            let reasoning = cfg
                .and_then(|c| c.pointer("/optionSpecs/reasoningLevel"))
                .and_then(|r| {
                    let values: Vec<String> = r
                        .get("values")
                        .and_then(Value::as_array)?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                    let map = r.get("map").and_then(Value::as_str)?.to_string();
                    if values.is_empty() {
                        return None;
                    }
                    Some(ReasoningLevelSpec { values, map })
                });
            items.push(ProviderModelSummary {
                model_id,
                enabled: cfg
                    .and_then(|c| c.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                context_window,
                supports_image,
                reasoning,
            });
        }
    }
    items
}

// ---------------------------------------------------------------------------
// 写入（备份 + 原子写）
// ---------------------------------------------------------------------------

fn backup_and_write(paths: &ZCodePaths, config: &Value) -> Result<Option<String>, CoreError> {
    let mut backup_path = None;
    if paths.provider_config_path.exists() {
        let backups_dir = paths.provider_config_backups_dir.clone();
        fs::create_dir_all(&backups_dir)?;
        let name = format!(
            "{}-{}.json",
            current_timestamp(),
            uuid::Uuid::new_v4().simple()
        );
        let target = backups_dir.join(&name);
        fs::copy(&paths.provider_config_path, &target)?;
        prune_backups(&backups_dir, MAX_CONFIG_BACKUPS);
        backup_path = Some(target.to_string_lossy().to_string());
    }

    if let Some(parent) = paths.provider_config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = paths.provider_config_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(config)?)?;
    fs::rename(&tmp, &paths.provider_config_path)?;
    Ok(backup_path)
}

fn prune_backups(dir: &Path, keep: usize) {
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

/// 取出可变引用；不存在时按路径逐级创建。
fn ensure_pointer<'a>(root: &'a mut Value, path: &[&str], default: Value) -> &'a mut Value {
    let mut current = root;
    for key in path {
        if !current.get(*key).map_or(false, Value::is_object) {
            current[*key] = json!({});
        }
        current = current.get_mut(*key).expect("刚补齐为对象");
    }
    if current.is_null() {
        *current = default;
    }
    current
}

fn provider_rules_mut(config: &mut Value) -> &mut Vec<Value> {
    ensure_pointer(
        config,
        &["config", "providerConfigRules"],
        json!({}),
    );
    let rules = config
        .pointer("/config/providerConfigRules/providerRules")
        .map_or_else(|| json!([]), Clone::clone);
    let arr = ensure_pointer(
        config,
        &["config", "providerConfigRules", "providerRules"],
        rules,
    );
    arr.as_array_mut().expect("providerRules 已是数组")
}

fn model_rules_mut(config: &mut Value) -> &mut Vec<Value> {
    ensure_pointer(config, &["config", "modelConfigRules"], json!({}));
    let rules = config
        .pointer("/config/modelConfigRules/providerModelRules")
        .map_or_else(|| json!([]), Clone::clone);
    let arr = ensure_pointer(
        config,
        &["config", "modelConfigRules", "providerModelRules"],
        rules,
    );
    arr.as_array_mut().expect("providerModelRules 已是数组")
}

fn provider_order_mut(config: &mut Value) -> &mut Vec<Value> {
    let order = config
        .pointer("/config/providerOrder")
        .map_or_else(|| json!([]), Clone::clone);
    let arr = ensure_pointer(config, &["config", "providerOrder"], order);
    arr.as_array_mut().expect("providerOrder 已是数组")
}

fn existing_provider_ids(config: &Value) -> Vec<String> {
    config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(|r| r.get("providerId").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn slugify(name: &str) -> String {
    let mut slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    // 收敛连续 '-' 与首尾 '-'
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "new-provider".to_string()
    } else {
        slug
    }
}

fn unique_provider_id(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|id| id == base) {
        return base.to_string();
    }
    for n in 2..=1000u32 {
        let candidate = format!("{base}-{n}");
        if !taken.iter().any(|id| id == &candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", uuid::Uuid::new_v4().simple())
}

// ---------------------------------------------------------------------------
// 推理档位模板（CEL 方言：三元/比较/对象字面量，无成员访问与函数调用）
// ---------------------------------------------------------------------------

pub fn default_reasoning_spec(
    api_type: ProviderApiType,
    levels: &[String],
) -> Option<ReasoningLevelSpec> {
    let values: Vec<String> = if levels.is_empty() {
        match api_type {
            ProviderApiType::AnthropicMessages => {
                vec!["off".into(), "low".into(), "medium".into(), "high".into()]
            }
            _ => vec!["low".into(), "medium".into(), "high".into()],
        }
    } else {
        levels.to_vec()
    };
    if values.is_empty() {
        return None;
    }

    let map = match api_type {
        ProviderApiType::OpenaiResponses => "{'reasoning': {'effort': reasoningLevel}}".to_string(),
        ProviderApiType::OpenaiChatCompletions => {
            "{'reasoning_effort': reasoningLevel}".to_string()
        }
        ProviderApiType::AnthropicMessages => {
            let budgets = [8192i64, 16384, 32768, 65536];
            let last = values.len() - 1;
            let mut map = String::new();
            let mut depth = 0usize;
            for (index, level) in values.iter().enumerate() {
                let branch = if level == "off" {
                    "{'thinking': {'type': 'disabled'}}".to_string()
                } else {
                    let budget = budgets[index.min(budgets.len() - 1)];
                    format!("{{'thinking': {{'type': 'enabled', 'budget_tokens': {budget}}}}}")
                };
                if index == last {
                    map.push_str(&branch);
                } else {
                    map.push_str(&format!(
                        "reasoningLevel == '{level}' ? {branch} : ("
                    ));
                    depth += 1;
                }
            }
            for _ in 0..depth {
                map.push(')');
            }
            map
        }
    };

    Some(ReasoningLevelSpec { values, map })
}

pub fn validate_reasoning_map(map: &str) -> Vec<CoreWarning> {
    let mut warnings = Vec::new();
    let trimmed = map.trim();
    if trimmed.is_empty() {
        warnings.push(CoreWarning {
            code: "reasoningMapEmpty".into(),
            message: "档位映射表达式为空，将使用按协议生成的默认模板。".into(),
        });
        return warnings;
    }
    if !trimmed.contains("reasoningLevel") {
        warnings.push(CoreWarning {
            code: "reasoningMapMissingVariable".into(),
            message: "表达式未引用 reasoningLevel，档位将不会影响请求。".into(),
        });
    }
    let balance = |open: char, close: char| -> i32 {
        trimmed
            .chars()
            .fold(0i32, |acc, c| if c == open { acc + 1 } else if c == close { acc - 1 } else { acc })
    };
    if balance('{', '}') != 0 || balance('(', ')') != 0 {
        warnings.push(CoreWarning {
            code: "reasoningMapUnbalanced".into(),
            message: "括号不配对，表达式可能无法编译。".into(),
        });
    }
    let quote_count = trimmed.chars().filter(|c| *c == '\'' || *c == '"').count();
    if quote_count % 2 != 0 {
        warnings.push(CoreWarning {
            code: "reasoningMapQuotes".into(),
            message: "引号不配对，表达式可能无法编译。".into(),
        });
    }
    let chars: Vec<char> = trimmed.chars().collect();
    for i in 0..chars.len().saturating_sub(1) {
        if chars[i] == '.' && chars[i + 1].is_alphabetic() {
            warnings.push(CoreWarning {
                code: "reasoningMapMemberAccess".into(),
                message: "检测到 '.' 成员访问；ZCode 的 CEL 方言不支持成员访问。".into(),
            });
            break;
        }
        // '(' 紧跟在字母后 = 函数调用；方言不支持（分组括号前面是空格或 '?'/':'）
        if chars[i].is_alphanumeric() || chars[i] == '_' {
            if chars[i + 1] == '(' {
                warnings.push(CoreWarning {
                    code: "reasoningMapFunctionCall".into(),
                    message: "检测到函数调用；ZCode 的 CEL 方言不支持函数调用。".into(),
                });
                break;
            }
        }
    }
    warnings
}

// ---------------------------------------------------------------------------
// 拉模型 / 连通性测试
// ---------------------------------------------------------------------------

fn build_client(timeout: Duration) -> Result<reqwest::blocking::Client, CoreError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .build()
        .map_err(|e| CoreError::OperationFailed(format!("HTTP 客户端创建失败：{e}")))
}

fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn extract_model_ids(body: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let collect = |value: &Value, ids: &mut Vec<String>| {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            ids.push(id.to_string());
        } else if let Some(name) = value.get("name").and_then(Value::as_str) {
            ids.push(name.to_string());
        }
    };
    if let Some(data) = body.get("data").and_then(Value::as_array) {
        for item in data {
            collect(item, &mut ids);
        }
    } else if let Some(data) = body.get("models").and_then(Value::as_array) {
        for item in data {
            collect(item, &mut ids);
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

pub fn fetch_provider_models(
    api_type: ProviderApiType,
    base_url: &str,
    api_key: &str,
    timeout: Duration,
) -> Result<Vec<String>, CoreError> {
    let client = build_client(timeout)?;
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("baseUrl 不能为空".into()));
    }

    let (url, request) = match api_type {
        ProviderApiType::AnthropicMessages => {
            let url = format!("{base}/v1/models");
            (
                url.clone(),
                client
                    .get(url)
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01"),
            )
        }
        _ => {
            let url = format!("{base}/models");
            (
                url.clone(),
                client.get(url).header("Authorization", format!("Bearer {api_key}")),
            )
        }
    };

    let response = request.send().map_err(|e| {
        CoreError::OperationFailed(format!("请求失败（{url}）：{e}"))
    })?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(CoreError::OperationFailed(format!(
            "HTTP {}: {}",
            status.as_u16(),
            body_text.chars().take(200).collect::<String>()
        )));
    }
    let body: Value = serde_json::from_str(&body_text)
        .map_err(|e| CoreError::InvalidData(format!("响应不是合法 JSON：{e}")))?;
    let ids = extract_model_ids(&body);
    if ids.is_empty() {
        return Err(CoreError::InvalidData(
            "响应中未找到模型列表（期望 data[].id）".into(),
        ));
    }
    Ok(ids)
}

pub fn test_provider_connectivity(
    api_type: ProviderApiType,
    base_url: &str,
    api_key: &str,
    timeout: Duration,
) -> ProviderConnectivityPayload {
    let started = Instant::now();
    let base = normalize_base(base_url);
    if base.is_empty() {
        return ProviderConnectivityPayload {
            reachable: false,
            status_code: None,
            message: "baseUrl 不能为空".into(),
            latency_ms: None,
        };
    }
    let result = match build_client(timeout) {
        Ok(client) => {
            let request = match api_type {
                ProviderApiType::AnthropicMessages => client
                    .get(format!("{base}/v1/models"))
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01"),
                _ => client
                    .get(format!("{base}/models"))
                    .header("Authorization", format!("Bearer {api_key}")),
            };
            request.send().map_err(CoreError::from).map(|response| {
                let status_code = response.status().as_u16() as i32;
                (status_code, response.status().is_success())
            })
        }
        Err(e) => Err(e),
    };

    match result {
        Ok((status_code, _success)) => {
            let latency = started.elapsed().as_millis() as u64;
            let reachable = true;
            let message = if (400..500).contains(&status_code) {
                format!("服务器可达，但 Key 校验失败（HTTP {status_code}）")
            } else {
                format!("连接正常（HTTP {status_code}）")
            };
            ProviderConnectivityPayload {
                reachable,
                status_code: Some(status_code),
                message,
                latency_ms: Some(latency),
            }
        }
        Err(e) => ProviderConnectivityPayload {
            reachable: false,
            status_code: None,
            message: format!("无法连接到服务器：{e}"),
            latency_ms: None,
        },
    }
}

// ---------------------------------------------------------------------------
// upsert / remove / set_enabled
// ---------------------------------------------------------------------------

/// 对已保存供应商的某个注入模型做真实推理测试（对应原版 AiMaMi 的模型测试）：
/// 按协议发送一条最小请求，验证 Key、中转与该模型本身都可用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelTestPayload {
    pub success: bool,
    pub status_code: Option<i32>,
    pub latency_ms: Option<u64>,
    pub message: String,
    pub reply_preview: Option<String>,
}

/// 对已保存的供应商做连通性测试：Key 只在后端读取，绝不回传前端。
pub fn test_saved_provider(
    paths: &ZCodePaths,
    provider_id: &str,
) -> Result<ProviderConnectivityPayload, CoreError> {
    let (config, exists) = read_config(paths)?;
    if !exists {
        return Err(CoreError::NotFound(format!("供应商不存在：{provider_id}")));
    }
    let rule = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules
                .iter()
                .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id))
                .cloned()
        })
        .ok_or_else(|| CoreError::NotFound(format!("供应商不存在：{provider_id}")))?;

    let cfg = rule.get("config").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 config：{provider_id}"))
    })?;
    let api = cfg.get("api").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 api 配置：{provider_id}"))
    })?;
    let api_type = match api.get("type").and_then(Value::as_str) {
        Some("openai-responses") => ProviderApiType::OpenaiResponses,
        Some("openai-chat-completions") => ProviderApiType::OpenaiChatCompletions,
        Some("anthropic-messages") => ProviderApiType::AnthropicMessages,
        other => {
            return Err(CoreError::InvalidData(format!(
                "未知的协议类型：{other:?}"
            )))
        }
    };
    let base_url = api
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = cfg
        .pointer("/access/apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if api_key.is_empty() {
        return Err(CoreError::InvalidData(
            "该供应商未配置 API Key，请先在编辑表单中填写".into(),
        ));
    }

    Ok(test_provider_connectivity(
        api_type,
        &base_url,
        &api_key,
        Duration::from_secs(10),
    ))
}

/// 解析已保存供应商的请求端点（协议 / baseUrl / Key），Key 只在后端流转。
fn resolve_provider_endpoint(
    paths: &ZCodePaths,
    provider_id: &str,
) -> Result<(ProviderApiType, String, String), CoreError> {
    let (config, exists) = read_config(paths)?;
    if !exists {
        return Err(CoreError::NotFound(format!("供应商不存在：{provider_id}")));
    }
    let rule = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules
                .iter()
                .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id))
                .cloned()
        })
        .ok_or_else(|| CoreError::NotFound(format!("供应商不存在：{provider_id}")))?;
    let cfg = rule.get("config").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 config：{provider_id}"))
    })?;
    let api = cfg.get("api").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 api 配置：{provider_id}"))
    })?;
    let api_type = match api.get("type").and_then(Value::as_str) {
        Some("openai-responses") => ProviderApiType::OpenaiResponses,
        Some("openai-chat-completions") => ProviderApiType::OpenaiChatCompletions,
        Some("anthropic-messages") => ProviderApiType::AnthropicMessages,
        other => {
            return Err(CoreError::InvalidData(format!(
                "未知的协议类型：{other:?}"
            )))
        }
    };
    let base_url = api
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = cfg
        .pointer("/access/apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if api_key.is_empty() {
        return Err(CoreError::InvalidData(
            "该供应商未配置 API Key，请先在编辑表单中填写".into(),
        ));
    }
    Ok((api_type, base_url, api_key))
}

pub fn test_provider_model(
    paths: &ZCodePaths,
    provider_id: &str,
    model_id: &str,
) -> Result<ProviderModelTestPayload, CoreError> {
    let (config, exists) = read_config(paths)?;
    if !exists {
        return Err(CoreError::NotFound(format!("供应商不存在：{provider_id}")));
    }
    let rule = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules
                .iter()
                .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id))
                .cloned()
        })
        .ok_or_else(|| CoreError::NotFound(format!("供应商不存在：{provider_id}")))?;

    let cfg = rule.get("config").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 config：{provider_id}"))
    })?;
    let api = cfg.get("api").ok_or_else(|| {
        CoreError::InvalidData(format!("供应商规则缺少 api 配置：{provider_id}"))
    })?;
    let api_type = match api.get("type").and_then(Value::as_str) {
        Some("openai-responses") => ProviderApiType::OpenaiResponses,
        Some("openai-chat-completions") => ProviderApiType::OpenaiChatCompletions,
        Some("anthropic-messages") => ProviderApiType::AnthropicMessages,
        other => {
            return Err(CoreError::InvalidData(format!(
                "未知的协议类型：{other:?}"
            )))
        }
    };
    let base_url = api
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = cfg
        .pointer("/access/apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if api_key.is_empty() {
        return Err(CoreError::InvalidData(
            "该供应商未配置 API Key，请先在编辑表单中填写".into(),
        ));
    }

    // 模型必须在注入列表里
    let in_rules = config
        .pointer("/config/modelConfigRules/providerModelRules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules.iter().any(|r| {
                r.get("providerId").and_then(Value::as_str) == Some(provider_id)
                    && r.get("modelId").and_then(Value::as_str) == Some(model_id)
            })
        })
        .unwrap_or(false);
    let in_personal = rule
        .pointer("/config/personalModelIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .any(|v| v.as_str() == Some(model_id))
        })
        .unwrap_or(false);
    if !in_rules && !in_personal {
        return Err(CoreError::NotFound(format!(
            "模型未注入到该供应商：{model_id}"
        )));
    }

    Ok(send_model_probe(api_type, &base_url, &api_key, model_id))
}

/// 按协议发送一条最小推理请求；200 且解析出模型回复才算可用。
fn send_model_probe(
    api_type: ProviderApiType,
    base_url: &str,
    api_key: &str,
    model_id: &str,
) -> ProviderModelTestPayload {
    let fail = |message: String| ProviderModelTestPayload {
        success: false,
        status_code: None,
        latency_ms: None,
        message,
        reply_preview: None,
    };

    let base = normalize_base(base_url);
    if base.is_empty() {
        return fail("baseUrl 不能为空".into());
    }
    let client = match build_client(Duration::from_secs(60)) {
        Ok(client) => client,
        Err(e) => return fail(format!("HTTP 客户端创建失败：{e}")),
    };

    // 推理请求可能慢，总超时放宽到 60s
    let (url, mut body) = match api_type {
        ProviderApiType::OpenaiResponses => (
            format!("{base}/responses"),
            json!({ "model": model_id, "input": "hi", "max_output_tokens": 32 }),
        ),
        ProviderApiType::OpenaiChatCompletions => (
            format!("{base}/chat/completions"),
            json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "hi" }],
                "max_tokens": 32
            }),
        ),
        ProviderApiType::AnthropicMessages => (
            format!("{base}/v1/messages"),
            json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "hi" }],
                "max_tokens": 32
            }),
        ),
    };

    let send = |body: &Value| -> Result<reqwest::blocking::Response, CoreError> {
        let mut request = client.post(&url).json(body);
        request = match api_type {
            ProviderApiType::AnthropicMessages => request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01"),
            _ => request.header("Authorization", format!("Bearer {api_key}")),
        };
        request
            .send()
            .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))
    };

    let started = Instant::now();
    let response = match send(&body) {
        Ok(response) => response,
        Err(e) => return fail(format!("无法连接到服务器：{e}")),
    };
    let status_code = response.status().as_u16() as i32;
    let body_text = response.text().unwrap_or_default();

    // 部分推理模型只认 max_completion_tokens 或不接受 max_tokens，遇 400 提到该字段就去掉重试一次
    if status_code == 400
        && api_type == ProviderApiType::OpenaiChatCompletions
        && (body_text.contains("max_tokens") || body_text.contains("max_completion_tokens"))
    {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("max_tokens");
        }
        if let Ok(retry) = send(&body) {
            let retry_status = retry.status().as_u16() as i32;
            let retry_text = retry.text().unwrap_or_default();
            return model_probe_finish(api_type, retry_status, &retry_text, started.elapsed().as_millis() as u64);
        }
    }

    model_probe_finish(api_type, status_code, &body_text, started.elapsed().as_millis() as u64)
}

fn model_probe_finish(
    api_type: ProviderApiType,
    status_code: i32,
    body_text: &str,
    latency_ms: u64,
) -> ProviderModelTestPayload {
    let parsed: Result<Value, _> = serde_json::from_str(body_text);
    let body = parsed.ok();
    let error_text = body
        .as_ref()
        .and_then(|b| b.get("error"))
        .map(|e| match e {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        });

    let preview = body.as_ref().and_then(|b| extract_reply_preview(api_type, b));

    if let Some(error_text) = error_text {
        return ProviderModelTestPayload {
            success: false,
            status_code: Some(status_code),
            latency_ms: Some(latency_ms),
            message: format!(
                "模型请求被拒绝（HTTP {status_code}）：{}",
                error_text.chars().take(200).collect::<String>()
            ),
            reply_preview: None,
        };
    }

    if (200..300).contains(&status_code) {
        match preview {
            Some(text) => ProviderModelTestPayload {
                success: true,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                message: format!("模型可用（HTTP {status_code}，{latency_ms}ms）"),
                reply_preview: Some(text),
            },
            None => ProviderModelTestPayload {
                success: false,
                status_code: Some(status_code),
                latency_ms: Some(latency_ms),
                message: format!(
                    "HTTP {status_code} 但未解析到模型回复：{}",
                    body_text.chars().take(200).collect::<String>()
                ),
                reply_preview: None,
            },
        }
    } else {
        ProviderModelTestPayload {
            success: false,
            status_code: Some(status_code),
            latency_ms: Some(latency_ms),
            message: format!(
                "模型请求失败（HTTP {status_code}）：{}",
                body_text.chars().take(200).collect::<String>()
            ),
            reply_preview: None,
        }
    }
}

fn extract_reply_preview(api_type: ProviderApiType, body: &Value) -> Option<String> {
    let collect_text = |text: String| -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(80).collect())
        }
    };

    match api_type {
        ProviderApiType::OpenaiChatCompletions => {
            let content = body
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(str::to_string);
            content.and_then(collect_text)
        }
        ProviderApiType::OpenaiResponses => {
            if let Some(text) = body.get("output_text").and_then(Value::as_str) {
                return collect_text(text.to_string());
            }
            let mut parts = Vec::new();
            if let Some(output) = body.get("output").and_then(Value::as_array) {
                for item in output {
                    if item.get("type").and_then(Value::as_str) != Some("message") {
                        continue;
                    }
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for piece in content {
                            if piece.get("type").and_then(Value::as_str) == Some("output_text") {
                                if let Some(text) = piece.get("text").and_then(Value::as_str) {
                                    parts.push(text.to_string());
                                }
                            }
                        }
                    }
                }
            }
            if parts.is_empty() {
                None
            } else {
                collect_text(parts.join(" "))
            }
        }
        ProviderApiType::AnthropicMessages => {
            let mut parts = Vec::new();
            if let Some(content) = body.get("content").and_then(Value::as_array) {
                for item in content {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                        }
                    }
                }
            }
            if parts.is_empty() {
                None
            } else {
                collect_text(parts.join(" "))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 流式模型测试（对应原版 AiMaMi 的「连通性测试」：分阶段计时 + 响应流）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamTestStage {
    Sent,
    Headers,
    FirstPacket,
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStreamTestPayload {
    pub success: bool,
    pub provider_id: String,
    pub model_id: String,
    pub status_code: Option<i32>,
    pub host: String,
    pub path: String,
    pub header_ms: Option<u64>,
    pub first_packet_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub reply: String,
    pub message: String,
}

fn host_of(base_url: &str) -> String {
    let without_scheme = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    authority.split(':').next().unwrap_or(authority).to_string()
}

/// 对注入模型发起一次真实流式推理请求，分阶段回报进度并记录耗时。
/// 进度通过 `on_progress(stage, status_code, elapsed_ms)` 回调，由命令层转发给前端。
pub fn stream_test_provider_model(
    paths: &ZCodePaths,
    provider_id: &str,
    model_id: &str,
    on_progress: &dyn Fn(StreamTestStage, Option<i32>, u64),
) -> Result<ProviderStreamTestPayload, CoreError> {
    let (api_type, base_url, api_key) = resolve_provider_endpoint(paths, provider_id)?;
    let base = normalize_base(&base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("baseUrl 不能为空".into()));
    }

    // 模型必须在注入列表里
    let (config, _) = read_config(paths)?;
    let in_rules = config
        .pointer("/config/modelConfigRules/providerModelRules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules.iter().any(|r| {
                r.get("providerId").and_then(Value::as_str) == Some(provider_id)
                    && r.get("modelId").and_then(Value::as_str) == Some(model_id)
            })
        })
        .unwrap_or(false);
    let in_personal = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules
                .iter()
                .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id))
        })
        .and_then(|rule| rule.pointer("/config/personalModelIds"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().any(|v| v.as_str() == Some(model_id)))
        .unwrap_or(false);
    if !in_rules && !in_personal {
        return Err(CoreError::NotFound(format!(
            "模型未注入到该供应商：{model_id}"
        )));
    }

    let (url, _path, body) = match api_type {
        ProviderApiType::OpenaiResponses => (
            format!("{base}/responses"),
            "/responses",
            json!({ "model": model_id, "input": "hi", "stream": true, "max_output_tokens": 32 }),
        ),
        ProviderApiType::OpenaiChatCompletions => (
            format!("{base}/chat/completions"),
            "/chat/completions",
            json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true,
                "max_tokens": 32
            }),
        ),
        ProviderApiType::AnthropicMessages => (
            format!("{base}/v1/messages"),
            "/v1/messages",
            json!({
                "model": model_id,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": true,
                "max_tokens": 32
            }),
        ),
    };
    let host = host_of(&base);
    // 终端面板展示用：完整请求路径（含 baseUrl 里的 /v1 等前缀），与原版一致
    let display_path = url_path_of(&url);

    let client = build_client(Duration::from_secs(120))?;
    let started = Instant::now();
    on_progress(StreamTestStage::Sent, None, 0);

    let mut request = client.post(&url).json(&body);
    request = match api_type {
        ProviderApiType::AnthropicMessages => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("Authorization", format!("Bearer {api_key}")),
    };
    let response = match request.send() {
        Ok(response) => response,
        Err(e) => {
            return Err(CoreError::OperationFailed(format!(
                "无法连接到服务器：{e}"
            )))
        }
    };
    let status_code = response.status().as_u16() as i32;
    let header_ms = started.elapsed().as_millis() as u64;
    on_progress(StreamTestStage::Headers, Some(status_code), header_ms);

    let finish_fail = |status_code: Option<i32>, message: String| ProviderStreamTestPayload {
        success: false,
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        status_code,
        host: host.clone(),
        path: display_path.clone(),
        header_ms: Some(header_ms),
        first_packet_ms: None,
        total_ms: Some(started.elapsed().as_millis() as u64),
        reply: String::new(),
        message,
    };

    if !(200..300).contains(&status_code) {
        let text = response.text().unwrap_or_default();
        let message = format!(
            "模型请求失败（HTTP {status_code}）：{}",
            text.chars().take(200).collect::<String>()
        );
        on_progress(StreamTestStage::Done, Some(status_code), started.elapsed().as_millis() as u64);
        return Ok(finish_fail(Some(status_code), message));
    }

    // 逐行读 SSE 流；首个 data: 行记为首包，累积文本增量
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(response);
    let mut reply = String::new();
    let mut first_packet_ms: Option<u64> = None;
    let mut read_error: Option<String> = None;
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                read_error = Some(format!("{e}"));
                break;
            }
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if first_packet_ms.is_none() && trimmed.starts_with("data:") {
            first_packet_ms = Some(started.elapsed().as_millis() as u64);
            on_progress(
                StreamTestStage::FirstPacket,
                Some(status_code),
                first_packet_ms.unwrap_or(0),
            );
        }
        if let Some(data) = trimmed.strip_prefix("data:") {
            let data = data.trim();
            if data == "[DONE]" {
                break;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = stream_delta_text(api_type, &value) {
                    reply.push_str(&delta);
                    if reply.chars().count() >= 400 {
                        break;
                    }
                }
            }
        }
    }

    let total_ms = started.elapsed().as_millis() as u64;
    on_progress(StreamTestStage::Done, Some(status_code), total_ms);

    let reply = reply.trim().to_string();
    let payload = if let Some(error) = read_error {
        finish_fail(
            Some(status_code),
            format!("流式读取中断：{error}"),
        )
    } else if reply.is_empty() {
        finish_fail(
            Some(status_code),
            format!("HTTP {status_code} 但流中没有解析到模型回复"),
        )
    } else {
        ProviderStreamTestPayload {
            success: true,
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            status_code: Some(status_code),
            host,
            path: display_path,
            header_ms: Some(header_ms),
            first_packet_ms,
            total_ms: Some(total_ms),
            reply: reply.chars().take(400).collect(),
            message: format!("模型可用（HTTP {status_code}）"),
        }
    };
    Ok(payload)
}

/// 从完整 URL 取出 path 部分（含 /v1 等前缀），用于终端面板展示。
fn url_path_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.find('/').map(|index| rest[index..].to_string()))
        .unwrap_or_else(|| "/".to_string())
}

fn stream_delta_text(api_type: ProviderApiType, value: &Value) -> Option<String> {
    let text = match api_type {
        ProviderApiType::OpenaiChatCompletions => value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        ProviderApiType::OpenaiResponses => {
            let kind = value.get("type").and_then(Value::as_str);
            if kind == Some("response.output_text.delta") {
                value.get("delta").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        }
        ProviderApiType::AnthropicMessages => {
            if value.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                value
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            }
        }
    };
    text.filter(|s| !s.is_empty())
}

pub fn upsert_provider(
    paths: &ZCodePaths,
    input: &ProviderUpsertInput,
) -> Result<ProviderMutationPayload, CoreError> {
    let name = input.provider_name.trim();
    if name.is_empty() {
        return Err(CoreError::InvalidData("供应商名称不能为空".into()));
    }
    if input.models.is_empty() {
        return Err(CoreError::InvalidData("至少选择一个模型".into()));
    }
    let base_url = normalize_base(&input.base_url);
    if base_url.is_empty() {
        return Err(CoreError::InvalidData("baseUrl 不能为空".into()));
    }
    let mut model_ids: Vec<String> = Vec::new();
    for model in &input.models {
        let id = model.model_id.trim();
        if id.is_empty() {
            return Err(CoreError::InvalidData("模型 ID 不能为空".into()));
        }
        if model_ids.iter().any(|x| x == id) {
            return Err(CoreError::InvalidData(format!("模型重复：{id}")));
        }
        model_ids.push(id.to_string());
    }

    let (mut config, _) = read_config(paths)?;

    // 确定 providerId：显式指定时不允许与其它供应商冲突；否则由名称生成并去重
    let provider_id = match input.provider_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(explicit) => {
            let taken: Vec<String> = existing_provider_ids(&config)
                .into_iter()
                .filter(|id| id != explicit)
                .collect();
            if taken.iter().any(|id| id == explicit) {
                return Err(CoreError::InvalidData(format!(
                    "providerId 已被其他供应商占用：{explicit}"
                )));
            }
            explicit.to_string()
        }
        None => {
            let taken = existing_provider_ids(&config);
            unique_provider_id(&slugify(name), &taken)
        }
    };

    // --- provider rule ---
    let rules = provider_rules_mut(&mut config);
    let existing_rule = rules
        .iter()
        .position(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()))
        .map(|index| rules.remove(index));

    let mut rule = existing_rule.unwrap_or_else(|| {
        json!({
            "providerId": provider_id,
            "providerName": name,
            "config": {
                "group": "standard-personal",
                "access": { "type": "api-key" },
                "api": { "type": input.api_type.as_str() }
            }
        })
    });
    rule["providerName"] = Value::String(name.to_string());
    let cfg = rule
        .get_mut("config")
        .and_then(Value::as_object_mut)
        .expect("provider rule config 为对象");
    cfg.insert("group".into(), Value::String("standard-personal".into()));
    // access：新 key 非空则覆盖，否则保留原值
    let mut access = cfg
        .get("access")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "api-key" }));
    if !input.api_key.trim().is_empty() {
        access["apiKey"] = Value::String(input.api_key.trim().to_string());
    }
    cfg.insert("access".into(), access);
    cfg.insert(
        "api".into(),
        json!({ "type": input.api_type.as_str(), "baseUrl": base_url }),
    );
    cfg.insert(
        "personalModelIds".into(),
        json!(model_ids),
    );
    cfg.insert(
        "modelOrder".into(),
        json!(model_ids.clone()),
    );

    let rules = provider_rules_mut(&mut config);
    match rules
        .iter()
        .position(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()))
    {
        Some(index) => rules[index] = rule,
        None => rules.push(rule),
    }

    // --- model rules ---
    // 先移除该 provider 下不在本次列表中的旧规则，再 upsert
    {
        let model_rules = model_rules_mut(&mut config);
        model_rules.retain(|rule| {
            let same_provider =
                rule.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str());
            if !same_provider {
                return true;
            }
            let model_id = rule.get("modelId").and_then(Value::as_str).unwrap_or("");
            model_ids.iter().any(|id| id == model_id)
        });
    }

    for model in &input.models {
        let model_id = model.model_id.trim().to_string();
        let model_rules = model_rules_mut(&mut config);
        let position = model_rules
            .iter()
            .position(|r| {
                r.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
                    && r.get("modelId").and_then(Value::as_str) == Some(model_id.as_str())
            })
            .map(|index| model_rules.remove(index));

        let mut rule = position.unwrap_or_else(|| {
            json!({
                "providerId": provider_id,
                "modelId": model_id,
                "config": { "enabled": true }
            })
        });
        rule["modelId"] = Value::String(model_id.clone());
        rule["providerId"] = Value::String(provider_id.clone());

        let cfg_obj = rule
            .get_mut("config")
            .and_then(Value::as_object_mut)
            .expect("model rule config 为对象");
        cfg_obj.insert("enabled".into(), Value::Bool(true));

        // properties
        let mut properties = cfg_obj
            .get("properties")
            .cloned()
            .unwrap_or_else(|| json!({}));
        match model.context_window {
            Some(window) if window > 0 => properties["contextWindow"] = json!(window),
            _ => {
                if let Some(obj) = properties.as_object_mut() {
                    obj.remove("contextWindow");
                }
            }
        }
        match model.supports_image {
            Some(true) => {
                if properties.get("inputFormat").map_or(false, Value::is_object) {
                    properties["inputFormat"]["supportsImage"] = Value::Bool(true);
                } else {
                    properties["inputFormat"] = json!({ "supportsImage": true });
                }
            }
            _ => {
                if let Some(obj) = properties
                    .get_mut("inputFormat")
                    .and_then(Value::as_object_mut)
                {
                    obj.remove("supportsImage");
                }
            }
        }
        if properties.as_object().map_or(false, Map::is_empty) {
            cfg_obj.remove("properties");
        } else {
            cfg_obj.insert("properties".into(), properties);
        }

        // optionSpecs.reasoningLevel
        let levels = model.reasoning_levels.clone().unwrap_or_default();
        let map_override = model
            .reasoning_map
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let spec = match (map_override, levels.is_empty()) {
            (Some(map), false) => Some(ReasoningLevelSpec {
                values: levels.clone(),
                map: map.to_string(),
            }),
            (Some(map), true) => Some(ReasoningLevelSpec {
                values: vec![],
                map: map.to_string(),
            }),
            (None, false) => default_reasoning_spec(input.api_type, &levels),
            (None, true) => None,
        };

        match spec {
            Some(spec) => {
                let mut option_specs = cfg_obj
                    .get("optionSpecs")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                option_specs["reasoningLevel"] = json!({
                    "values": spec.values,
                    "map": spec.map,
                });
                cfg_obj.insert("optionSpecs".into(), option_specs);
            }
            None => {
                if let Some(obj) = cfg_obj.get_mut("optionSpecs").and_then(Value::as_object_mut) {
                    obj.remove("reasoningLevel");
                }
            }
        }

        let model_rules = model_rules_mut(&mut config);
        match model_rules
            .iter()
            .position(|r| {
                r.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
                    && r.get("modelId").and_then(Value::as_str) == Some(model_id.as_str())
            }) {
            Some(index) => model_rules[index] = rule,
            None => model_rules.push(rule),
        }
    }

    // --- providerOrder ---
    {
        let order = provider_order_mut(&mut config);
        if !order
            .iter()
            .any(|v| v.as_str() == Some(provider_id.as_str()))
        {
            order.push(Value::String(provider_id.clone()));
        }
    }

    // schemaVersion 兜底
    if config.get("schemaVersion").is_none() {
        config["schemaVersion"] = json!(1);
    }

    let backup_path = backup_and_write(paths, &config)?;

    // 重新读取生成摘要（避免手工再拼一次）
    let summary = rule_to_summary(
        &config
            .pointer("/config/providerConfigRules/providerRules")
            .and_then(Value::as_array)
            .and_then(|rules| {
                rules
                    .iter()
                    .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()))
                    .cloned()
            })
            .ok_or_else(|| CoreError::OperationFailed("写入后未找到供应商规则".into()))?,
        &config,
    )
    .ok_or_else(|| CoreError::OperationFailed("写入后摘要生成失败".into()))?;

    Ok(ProviderMutationPayload {
        provider: summary,
        backup_path,
    })
}

pub fn remove_provider(
    paths: &ZCodePaths,
    provider_id: &str,
) -> Result<ProviderRemovePayload, CoreError> {
    let (mut config, exists) = read_config(paths)?;
    if !exists {
        return Err(CoreError::NotFound(format!(
            "供应商不存在：{provider_id}"
        )));
    }

    let before = existing_provider_ids(&config);
    if !before.iter().any(|id| id == provider_id) {
        return Err(CoreError::NotFound(format!(
            "供应商不存在：{provider_id}"
        )));
    }

    {
        let rules = provider_rules_mut(&mut config);
        rules.retain(|r| r.get("providerId").and_then(Value::as_str) != Some(provider_id));
    }
    {
        let model_rules = model_rules_mut(&mut config);
        model_rules.retain(|r| r.get("providerId").and_then(Value::as_str) != Some(provider_id));
    }
    {
        let order = provider_order_mut(&mut config);
        order.retain(|v| v.as_str() != Some(provider_id));
    }

    let backup_path = backup_and_write(paths, &config)?;
    Ok(ProviderRemovePayload {
        removed_provider_id: provider_id.to_string(),
        backup_path,
    })
}

pub fn set_provider_enabled(
    paths: &ZCodePaths,
    provider_id: &str,
    enabled: bool,
) -> Result<ProviderMutationPayload, CoreError> {
    let (mut config, _) = read_config(paths)?;

    let exists = existing_provider_ids(&config)
        .iter()
        .any(|id| id == provider_id);
    if !exists {
        return Err(CoreError::NotFound(format!(
            "供应商不存在：{provider_id}"
        )));
    }

    {
        let model_rules = model_rules_mut(&mut config);
        for rule in model_rules.iter_mut() {
            if rule.get("providerId").and_then(Value::as_str) == Some(provider_id) {
                if rule.get("config").map_or(false, Value::is_object) {
                    rule["config"]["enabled"] = Value::Bool(enabled);
                } else {
                    rule["config"] = json!({ "enabled": enabled });
                }
            }
        }
    }

    let backup_path = backup_and_write(paths, &config)?;

    let summary = config
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules
                .iter()
                .find(|r| r.get("providerId").and_then(Value::as_str) == Some(provider_id))
                .cloned()
        })
        .and_then(|rule| rule_to_summary(&rule, &config))
        .ok_or_else(|| CoreError::NotFound(format!("供应商不存在：{provider_id}")))?;

    Ok(ProviderMutationPayload {
        provider: summary,
        backup_path,
    })
}
