//! NewAPI（new-api / one-api 系）站点接入：探测站点、读取令牌与分组、创建密钥。
//!
//! 仅调用站点 `/api/*` 管理接口，鉴权使用用户在站点后台生成的系统访问令牌
//! （`Authorization: Bearer`）。密钥明文只在返回值里短暂出现，前端只展示掩码。

use crate::core::models::CoreError;
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiSiteInfo {
    pub system_name: String,
    pub version: String,
    /// 已确认的站点用户 ID（New-Api-User 头需要；未知为 0）
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub group: String,
    /// 剩余额度（原始 quota，展示时除以 quota_per_unit）
    pub quota: i64,
    pub used_quota: i64,
    pub quota_per_unit: f64,
}

/// 个人中心：当前登录账号资料（/api/status + /api/user/self 全量字段）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUserProfile {
    pub system_name: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub group: String,
    /// new-api 角色：1 普通用户 / 10 管理 / 100 超管
    pub role: i64,
    pub quota: i64,
    pub used_quota: i64,
    pub request_count: i64,
    pub quota_per_unit: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiTokenInfo {
    pub id: i64,
    pub name: String,
    /// 1=启用 2=禁用 3=已过期 4=已耗尽
    pub status: i64,
    /// 裸 key（不含 sk- 前缀），部分字段缺失时为空串
    pub key: String,
    pub remain_quota: i64,
    pub used_quota: i64,
    pub unlimited_quota: bool,
    /// -1 = 永不过期
    pub expired_time: i64,
    pub created_time: i64,
    pub accessed_time: i64,
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiGroupInfo {
    pub name: String,
    pub ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiTokenDetail {
    pub id: i64,
    pub name: String,
    /// 裸 key（不含 sk- 前缀）；站点未回传时为空串，前端需引导手动补填
    pub key: String,
}

/// 一个时间窗内的消耗：quota 换算金额，tokens 为请求消耗的 token 总数
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUsageWindow {
    pub quota: i64,
    pub tokens: i64,
}

/// 仪表盘站点用量汇总：余额 + 今日 / 本周 / 本月三个窗口
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUsageSummary {
    pub system_name: String,
    pub balance_quota: i64,
    pub used_quota: i64,
    pub quota_per_unit: f64,
    pub today: NewApiUsageWindow,
    pub week: NewApiUsageWindow,
    pub month: NewApiUsageWindow,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewApiCreateTokenInput {
    pub name: String,
    /// 令牌分组；None/空串 = 使用用户默认分组
    pub group: Option<String>,
    pub unlimited_quota: bool,
    pub remain_quota: Option<i64>,
    /// 秒级 unix 时间戳；None = -1（永不过期）
    pub expired_time: Option<i64>,
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn as_i64(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .unwrap_or(0)
}

fn as_f64(value: &Value) -> f64 {
    value.as_f64().unwrap_or(1.0)
}

/// 日志 other 字段归一为 JSON 对象（站点实际返回 JSON 字符串，兼容对象形态）
fn parse_other_object(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v @ Value::Object(_)) => v.clone(),
        _ => Value::Null,
    }
}

/// 从 other 取首响毫秒数（frt）。非流式/缺失时站点写 -1000 哨兵，统一归一为 -1 表示无首字。
fn parse_frt_ms(other: &Value) -> i64 {
    other
        .get("frt")
        .and_then(Value::as_f64)
        .map(|f| f.round() as i64)
        .filter(|ms| *ms >= 0)
        .unwrap_or(-1)
}

/// new-api 统一信封：HTTP 200 且 success=true 时取 data，否则报错
/// 站点拒绝访问令牌的响应特征。注意 new-api 多数版本对无效令牌返回的是
/// HTTP 200 + success:false（aispot 实测），所以只能按 message 内容识别，
/// 不能依赖 401 状态码。
fn is_invalid_token_message(message: &str) -> bool {
    let lowered = message.to_lowercase();
    [
        "invalid access token",
        "无效的访问令牌",
        "访问令牌无效",
        "无效的令牌",
        "令牌已失效",
        "令牌不存在",
    ]
    .iter()
    .any(|pattern| lowered.contains(pattern))
}

/// 从失败响应体里尽量抠出可读信息：优先 JSON 的 message 字段，否则取前 200 字符
fn extract_failure_message(body_text: &str) -> String {
    if let Ok(body) = serde_json::from_str::<Value>(body_text) {
        if let Some(message) = body.get("message").and_then(Value::as_str) {
            if !message.is_empty() {
                return message.to_string();
            }
        }
    }
    body_text.chars().take(200).collect()
}

fn parse_envelope(status: reqwest::StatusCode, body_text: &str, url: &str) -> Result<Value, CoreError> {
    if !status.is_success() {
        if is_invalid_token_message(body_text) {
            return Err(CoreError::SiteTokenInvalid(extract_failure_message(body_text)));
        }
        let preview: String = body_text.chars().take(200).collect();
        return Err(CoreError::OperationFailed(format!(
            "HTTP {}: {}（{url}）",
            status.as_u16(),
            preview
        )));
    }
    let body: Value = serde_json::from_str(body_text)
        .map_err(|e| CoreError::InvalidData(format!("响应不是合法 JSON：{e}（{url}）")))?;
    let success = body.get("success").and_then(Value::as_bool).unwrap_or(false);
    if !success {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("站点返回失败，未提供原因");
        if is_invalid_token_message(message) {
            return Err(CoreError::SiteTokenInvalid(message.to_string()));
        }
        return Err(CoreError::OperationFailed(message.to_string()));
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

/// 已知用户 ID 时所有管理接口都要带 New-Api-User 头（新版 new-api 强校验，
/// 值必须与令牌归属的用户 ID 精确匹配；旧版/one-api 会忽略该头）
fn api_get(
    client: &reqwest::blocking::Client,
    url: &str,
    access_token: &str,
    user_id: Option<i64>,
) -> Result<Value, CoreError> {
    let response = authed_request(client, reqwest::Method::GET, url, access_token, user_id)
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    parse_envelope(status, &body_text, url)
}

fn authed_request(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    url: &str,
    access_token: &str,
    user_id: Option<i64>,
) -> reqwest::blocking::RequestBuilder {
    let mut request = client
        .request(method, url)
        .header("Authorization", format!("Bearer {access_token}"));
    if let Some(id) = user_id {
        request = request.header("New-Api-User", id.to_string());
    }
    request
}

/// 是否为「New-Api-User 头缺失/不匹配」类 401（各版本中英文文案都含该头名）
fn is_new_api_user_error(status: reqwest::StatusCode, body_text: &str) -> bool {
    status == reqwest::StatusCode::UNAUTHORIZED && body_text.contains("New-Api-User")
}

const NEW_API_USER_GUIDANCE: &str =
    "该站点开启了 New-Api-User 用户校验：请填入账号的用户 ID 后重试（站点控制台「个人设置」可查看数字 ID），或改用「账号密码」方式登录";

fn build_client(timeout: Duration) -> Result<reqwest::blocking::Client, CoreError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .build()
        .map_err(|e| CoreError::OperationFailed(format!("HTTP 客户端创建失败：{e}")))
}

fn parse_token(value: &Value) -> NewApiTokenInfo {
    NewApiTokenInfo {
        id: value.get("id").map(as_i64).unwrap_or(0),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status: value.get("status").map(as_i64).unwrap_or(1),
        key: value
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        remain_quota: value.get("remain_quota").map(as_i64).unwrap_or(0),
        used_quota: value.get("used_quota").map(as_i64).unwrap_or(0),
        unlimited_quota: value
            .get("unlimited_quota")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        expired_time: value.get("expired_time").map(as_i64).unwrap_or(-1),
        created_time: value.get("created_time").map(as_i64).unwrap_or(0),
        accessed_time: value.get("accessed_time").map(as_i64).unwrap_or(0),
        group: value
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// 列表类接口 data 的两种形态：旧版直接是数组，新版是 PageInfo 分页对象
/// { page, page_size, total, items }（aispot 实测为后者；日志接口同构）
fn envelope_items(data: &Value) -> Vec<Value> {
    match data {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// 拉令牌列表：不同版本分页起点不一致，首页为空时用 p=1 重试一次
fn fetch_token_page(
    client: &reqwest::blocking::Client,
    base: &str,
    access_token: &str,
    user_id: Option<i64>,
    page: u32,
) -> Result<Vec<NewApiTokenInfo>, CoreError> {
    let url = format!("{base}/api/token/?p={page}&size=100");
    let data = api_get(client, &url, access_token, user_id)?;
    Ok(envelope_items(&data).iter().map(parse_token).collect())
}

// ---------------------------------------------------------------------------
// 对外逻辑
// ---------------------------------------------------------------------------

/// 探测站点并验证访问令牌：/api/status（公开）+ /api/user/self（鉴权）。
///
/// user_id 为 None 且站点要求 New-Api-User 头时报错引导填写；成功返回的
/// user_id 取自 /api/user/self 响应，供连接流程落盘。
pub fn probe_site(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<NewApiSiteInfo, CoreError> {
    if access_token.trim().is_empty() {
        return Err(CoreError::InvalidData("访问令牌不能为空".into()));
    }
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("站点地址不能为空".into()));
    }
    let client = build_client(timeout)?;

    let status_data = api_get(&client, &format!("{base}/api/status"), access_token, user_id)?;
    let system_name = status_data
        .get("system_name")
        .and_then(Value::as_str)
        .unwrap_or("NewAPI")
        .to_string();
    let version = status_data
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let quota_per_unit = status_data
        .get("quota_per_unit")
        .map(as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500_000.0);

    let self_url = format!("{base}/api/user/self");
    let response = authed_request(&client, reqwest::Method::GET, &self_url, access_token, user_id)
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("请求失败（{self_url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    let user = match parse_envelope(status, &body_text, &self_url) {
        Ok(user) => user,
        Err(err) => {
            if user_id.is_none() && is_new_api_user_error(status, &body_text) {
                return Err(CoreError::OperationFailed(NEW_API_USER_GUIDANCE.into()));
            }
            return Err(err);
        }
    };
    Ok(NewApiSiteInfo {
        system_name,
        version,
        user_id: user.get("id").map(as_i64).unwrap_or(0),
        username: user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        display_name: user
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        group: user
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        quota: user.get("quota").map(as_i64).unwrap_or(0),
        used_quota: user.get("used_quota").map(as_i64).unwrap_or(0),
        quota_per_unit,
    })
}

/// 个人中心资料：/api/status（站点名与倍率）+ /api/user/self（账号全量字段）
pub fn user_profile(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<NewApiUserProfile, CoreError> {
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("站点地址不能为空".into()));
    }
    let client = build_client(timeout)?;

    let status_data = api_get(&client, &format!("{base}/api/status"), access_token, user_id)?;
    let system_name = status_data
        .get("system_name")
        .and_then(Value::as_str)
        .unwrap_or("NewAPI")
        .to_string();
    let quota_per_unit = status_data
        .get("quota_per_unit")
        .map(as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500_000.0);

    let user = api_get(&client, &format!("{base}/api/user/self"), access_token, user_id)?;
    Ok(NewApiUserProfile {
        system_name,
        username: user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        display_name: user
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        email: user
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        group: user
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        role: user.get("role").map(as_i64).unwrap_or(1),
        quota: user.get("quota").map(as_i64).unwrap_or(0),
        used_quota: user.get("used_quota").map(as_i64).unwrap_or(0),
        request_count: user.get("request_count").map(as_i64).unwrap_or(0),
        quota_per_unit,
    })
}

/// 账号密码登录换取系统访问令牌：
/// 1) POST /api/user/login（成功后站点下发会话 cookie；新版响应直接带 access_token）
/// 2) GET /api/user/token 用会话生成系统访问令牌（旧版路径，每次调用都会在站点侧重置令牌）
///
/// 仅旧版 new-api 走明文密码 JSON（目标站 /api/user/login/encryption-key 404 即此形态）；
/// 新版若开启密码加密需改走加密流程，这里暂不支持。
/// 返回 (访问令牌, 用户 ID)；用户 ID 取自登录响应，后续 New-Api-User 头必需。
pub fn login_with_password(
    base_url: &str,
    username: &str,
    password: &str,
    timeout: Duration,
) -> Result<(String, i64), CoreError> {
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("站点地址不能为空".into()));
    }
    if username.trim().is_empty() || password.is_empty() {
        return Err(CoreError::InvalidData("账号与密码不能为空".into()));
    }
    // 会话 cookie 只存在于带 cookie_store 的客户端里，与 api_get 的无状态客户端分开
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .cookie_store(true)
        .build()
        .map_err(|e| CoreError::OperationFailed(format!("HTTP 客户端创建失败：{e}")))?;

    let login_url = format!("{base}/api/user/login");
    let response = client
        .post(&login_url)
        .json(&json!({
            "username": username.trim(),
            "password": password,
            "turnstile": "",
        }))
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("登录请求失败（{login_url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    let data = parse_envelope(status, &body_text, &login_url)?;

    // 用户 ID：旧版 data 即用户对象（data.id），新版在 data.user.id
    let login_user_id = data
        .get("id")
        .or_else(|| data.get("user").and_then(|user| user.get("id")))
        .map(as_i64)
        .unwrap_or(0);

    let login_token = data
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(token) = login_token {
        return Ok((token, login_user_id));
    }
    // 既没有 access_token 也没有用户信息 = 站点插入了额外验证步骤（两步验证等）
    if data.get("username").is_none() {
        return Err(CoreError::OperationFailed(
            "站点登录后返回了额外验证步骤（可能开启了两步验证），请在站点后台生成访问令牌后改用「访问令牌」方式连接".into(),
        ));
    }

    let token_url = format!("{base}/api/user/token");
    // 会话鉴权：不带 Authorization 头；新版站点的会话路径同样要求 New-Api-User 头
    let mut request = client.get(&token_url);
    if login_user_id > 0 {
        request = request.header("New-Api-User", login_user_id.to_string());
    }
    let response = request
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("请求失败（{token_url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    let token_data = parse_envelope(status, &body_text, &token_url)?;

    let token = token_data
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            token_data
                .get("access_token")
                .or_else(|| token_data.get("token"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let token = token.ok_or_else(|| {
        CoreError::OperationFailed("站点未返回访问令牌，请改用「访问令牌」方式连接".into())
    })?;
    Ok((token, login_user_id))
}

/// 当前账号的令牌列表（key 字段可能被站点脱敏，见 reveal_token_key）
pub fn list_tokens(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<Vec<NewApiTokenInfo>, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let mut tokens = fetch_token_page(&client, &base, access_token, user_id, 0)?;
    if tokens.is_empty() {
        tokens = fetch_token_page(&client, &base, access_token, user_id, 1)?;
    }
    Ok(tokens)
}

/// 取回单个令牌的 key 明文。
///
/// 新版 new-api 的列表 / 详情 / 搜索接口一律对 key 脱敏
/// （`tzPX**********UpRs` 形态），明文必须走专用端点
/// `POST /api/token/{id}/key`（仅令牌所有者可用，且有限流）。
/// 站点过旧没有该端点时返回 404，由调用方回落引导。
pub fn reveal_token_key(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    token_id: i64,
    timeout: Duration,
) -> Result<String, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let url = format!("{base}/api/token/{token_id}/key");
    let response = authed_request(&client, reqwest::Method::POST, &url, access_token, user_id)
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    let data = parse_envelope(status, &body_text, &url)?;
    let key = data
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if key.is_empty() || key.contains('*') {
        return Err(CoreError::OperationFailed(
            "站点未返回明文 key（响应缺失或仍为脱敏值）".into(),
        ));
    }
    Ok(key)
}

/// 可选分组与计费倍率：/api/user/groups 返回 分组名 → 倍率 映射（或数组）
pub fn list_groups(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<Vec<NewApiGroupInfo>, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let data = api_get(
        &client,
        &format!("{base}/api/user/groups"),
        access_token,
        user_id,
    )?;

    let mut groups: Vec<NewApiGroupInfo> = Vec::new();
    match &data {
        Value::Object(map) => {
            for (name, value) in map {
                // 新版值为分组对象 { base_ratio, ratio, desc, ... }（aispot 实测），旧版直接是数字倍率
                let ratio = value
                    .get("ratio")
                    .or_else(|| value.get("base_ratio"))
                    .and_then(Value::as_f64)
                    .or_else(|| value.as_f64());
                if let Some(ratio) = ratio {
                    groups.push(NewApiGroupInfo {
                        name: name.clone(),
                        ratio,
                    });
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    groups.push(NewApiGroupInfo {
                        name: name.to_string(),
                        ratio: item.get("ratio").map(as_f64).unwrap_or(1.0),
                    });
                }
            }
        }
        _ => {}
    }
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(groups)
}

/// 当前账号可用模型：/api/user/models。
///
/// 指定 group 时结合 /api/pricing 的 enable_groups 过滤——站点把模型挂在不同
/// 分组（渠道）上，按分组接入时只应展示该分组实际可调用的模型。
pub fn list_models(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    group: Option<&str>,
    timeout: Duration,
) -> Result<Vec<String>, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let data = api_get(
        &client,
        &format!("{base}/api/user/models"),
        access_token,
        user_id,
    )?;
    let items = data.as_array().cloned().unwrap_or_default();
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|item| {
            if let Some(id) = item.as_str() {
                Some(id.to_string())
            } else {
                item.get("id")
                    .or_else(|| item.get("name"))
                    .or_else(|| item.get("model"))
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            }
        })
        .collect();

    if let Some(group) = group.map(str::trim).filter(|g| !g.is_empty()) {
        // /api/pricing 公开端点：data 为 [{model_name, enable_groups, ...}]
        let pricing = api_get(&client, &format!("{base}/api/pricing"), access_token, user_id)?;
        let allowed: std::collections::HashSet<String> = pricing
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|entry| {
                entry
                    .get("enable_groups")
                    .and_then(Value::as_array)
                    .map(|groups| {
                        groups
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|g| g == group)
                    })
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                entry
                    .get("model_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        ids.retain(|id| allowed.contains(id));
    }

    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// 推荐计划信息（数据取自 /api/user/self 的 aff_* 字段）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiAffiliateInfo {
    pub aff_code: String,
    pub referral_url: String,
    /// 待划转奖励（quota 原始单位）
    pub pending_quota: i64,
    /// 已历史划转奖励
    pub history_quota: i64,
    pub invite_count: i64,
}

/// 已邀请用户 / 推荐记录分页（items 字段名因站点版本而异，保持透传）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiAffiliatePage {
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub items: Vec<Value>,
}

/// 推荐计划：邀请码 / 推荐链接 / 待确认与累计奖励 / 邀请人数
pub fn affiliate_info(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<NewApiAffiliateInfo, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let data = api_get(&client, &format!("{base}/api/user/self"), access_token, user_id)?;
    let aff_code = data
        .get("aff_code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(NewApiAffiliateInfo {
        referral_url: if aff_code.is_empty() {
            String::new()
        } else {
            format!("{base}/sign-up?aff={aff_code}")
        },
        pending_quota: data.get("aff_quota").map_or(0, as_i64),
        history_quota: data.get("aff_history_quota").map_or(0, as_i64),
        invite_count: data.get("aff_count").map_or(0, as_i64),
        aff_code,
    })
}

/// 已邀请用户列表（新版 new-api：GET /api/user/invited-users）
pub fn invited_users(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    page: i64,
    page_size: i64,
    timeout: Duration,
) -> Result<NewApiAffiliatePage, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let data = api_get(
        &client,
        &format!("{base}/api/user/invited-users?p={page}&page_size={page_size}"),
        access_token,
        user_id,
    )?;
    Ok(NewApiAffiliatePage {
        page: data.get("page").map_or(page, as_i64),
        page_size: data.get("page_size").map_or(page_size, as_i64),
        total: data.get("total").map_or(0, as_i64),
        items: data.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

/// 划转邀请奖励到余额：POST /api/user/aff_transfer {"quota": N}（quota 原始单位）
pub fn transfer_aff_quota(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    quota: i64,
    timeout: Duration,
) -> Result<(), CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let url = format!("{base}/api/user/aff_transfer");
    let response = authed_request(&client, reqwest::Method::POST, &url, access_token, user_id)
        .json(&json!({ "quota": quota }))
        .send()
        .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    parse_envelope(status, &body_text, &url)?;
    Ok(())
}

/// 创建令牌并取回 key 明文。
///
/// new-api 的创建接口不保证返回 key，因此按唯一名称先走搜索接口、
/// 失败再退回全量列表精确匹配；仍取不到时 key 返回空串，由前端引导手动补填。
pub fn create_token(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    input: &NewApiCreateTokenInput,
    timeout: Duration,
) -> Result<NewApiTokenDetail, CoreError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(CoreError::InvalidData("密钥名称不能为空".into()));
    }
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;

    let mut payload = json!({
        "name": name,
        "remain_quota": input.remain_quota.unwrap_or(0),
        "expired_time": input.expired_time.unwrap_or(-1),
        "unlimited_quota": input.unlimited_quota,
        "model_limits_enabled": false,
        "model_limits": "",
        "allow_ips": "",
    });
    if let Some(group) = input.group.as_deref().filter(|g| !g.trim().is_empty()) {
        payload["group"] = json!(group.trim());
    }

    let url = format!("{base}/api/token/");
    let response = authed_request(
        &client,
        reqwest::Method::POST,
        &url,
        access_token,
        user_id,
    )
    .json(&payload)
    .send()
    .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    parse_envelope(status, &body_text, &url)?;

    // 搜索接口按名称精确匹配取回 key
    let search_url = format!("{base}/api/token/search?keyword={}&p=0&size=10", urlencoding(&name));
    let candidates = api_get(&client, &search_url, access_token, user_id)
        .map(|data| envelope_items(&data))
        .unwrap_or_default();
    let mut matched: Vec<NewApiTokenInfo> = candidates
        .iter()
        .map(parse_token)
        .filter(|t| t.name == name)
        .collect();

    // 兜底：全量列表里找同名令牌
    if matched.is_empty() {
        if let Ok(tokens) = list_tokens(base_url, access_token, user_id, timeout) {
            matched = tokens.into_iter().filter(|t| t.name == name).collect();
        }
    }

    matched.sort_by_key(|t| -t.created_time);
    let detail = match matched.first() {
        Some(first) => {
            // 新版 new-api 的列表 / 搜索响应 key 一律脱敏，需走专用端点取明文；
            // 取不到（站点过旧 / 限流）时回落旧字段，仍无则回传空串由前端引导补填
            let revealed = reveal_token_key(base_url, access_token, user_id, first.id, timeout)
                .or_else(|_| {
                    matched
                        .iter()
                        .find(|t| !t.key.is_empty() && !t.key.contains('*'))
                        .map(|t| Ok(t.key.clone()))
                        .unwrap_or_else(|| {
                            Err(CoreError::OperationFailed("no plaintext key".into()))
                        })
                })
                .unwrap_or_default();
            NewApiTokenDetail {
                id: first.id,
                name: first.name.clone(),
                key: revealed,
            }
        }
        None => NewApiTokenDetail {
            id: 0,
            name,
            key: String::new(),
        },
    };
    Ok(detail)
}

/// 极简百分号编码，仅用于搜索接口的 keyword 参数
fn urlencoding(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

// ---------------------------------------------------------------------------
// 仪表盘用量汇总
// ---------------------------------------------------------------------------

/// /api/data/self 的服务端限制：单次查询跨度不能超过 30 天（2592000 秒）
const QUOTA_DATA_MAX_SPAN: i64 = 2_592_000;

/// 本地时区的当日 / 本周（周一）/ 本月零点
fn local_window_starts() -> (i64, i64, i64) {
    let now_local = chrono::Local::now();
    let today = now_local.date_naive();
    let to_ts = |date: chrono::NaiveDate| -> i64 {
        date.and_hms_opt(0, 0, 0)
            .and_then(|dt| dt.and_local_timezone(chrono::Local).earliest())
            .map(|dt| dt.timestamp())
            .unwrap_or_else(|| now_local.timestamp())
    };
    let today_start = to_ts(today);
    let week_start =
        to_ts(today - chrono::Duration::days(now_local.weekday().num_days_from_monday() as i64));
    let month_start = to_ts(today.with_day(1).unwrap_or(today));
    (today_start, week_start, month_start)
}

/// 拉一段窗口的按小时聚合数据（created_at, quota, token_used）
fn fetch_quota_buckets(
    client: &reqwest::blocking::Client,
    base: &str,
    access_token: &str,
    user_id: Option<i64>,
    start: i64,
    end: i64,
) -> Result<Vec<(i64, i64, i64)>, CoreError> {
    let url = format!("{base}/api/data/self?start_timestamp={start}&end_timestamp={end}");
    let data = api_get(client, &url, access_token, user_id)?;
    let items = data.as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .map(|item| {
            (
                item.get("created_at").map(as_i64).unwrap_or(0),
                item.get("quota").map(as_i64).unwrap_or(0),
                item.get("token_used").map(as_i64).unwrap_or(0),
            )
        })
        .collect())
}

/// 跨度超 30 天时自动拆两段，合并总量
fn fetch_window(
    client: &reqwest::blocking::Client,
    base: &str,
    access_token: &str,
    user_id: Option<i64>,
    start: i64,
    end: i64,
) -> Result<NewApiUsageWindow, CoreError> {
    if end - start <= QUOTA_DATA_MAX_SPAN {
        let buckets = fetch_quota_buckets(client, base, access_token, user_id, start, end)?;
        Ok(NewApiUsageWindow {
            quota: buckets.iter().map(|(_, q, _)| q).sum(),
            tokens: buckets.iter().map(|(_, _, t)| t).sum(),
        })
    } else {
        let first = fetch_window(client, base, access_token, user_id, start, start + QUOTA_DATA_MAX_SPAN)?;
        let second = fetch_window(client, base, access_token, user_id, start + QUOTA_DATA_MAX_SPAN, end)?;
        Ok(NewApiUsageWindow {
            quota: first.quota + second.quota,
            tokens: first.tokens + second.tokens,
        })
    }
}

/// 降级：/api/data/self 不可用时，用 /api/log/self/stat 只取金额（拿不到 token 数）
fn stat_window_quota(
    client: &reqwest::blocking::Client,
    base: &str,
    access_token: &str,
    user_id: Option<i64>,
    start: i64,
    end: i64,
) -> Result<i64, CoreError> {
    let url = format!("{base}/api/log/self/stat?start_timestamp={start}&end_timestamp={end}");
    let data = api_get(client, &url, access_token, user_id)?;
    Ok(data.get("quota").map(as_i64).unwrap_or(0))
}

/// 仪表盘站点接入状态 + 用量汇总（未接入时 connected=false）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteUsagePayload {
    pub connected: bool,
    pub base_url: String,
    pub summary: Option<NewApiUsageSummary>,
}

/// 钱包页统计：余额 / 总用量 / API 请求数
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiWalletStats {
    pub system_name: String,
    pub username: String,
    pub balance_quota: i64,
    pub used_quota: i64,
    pub quota_per_unit: f64,
    /// 站点累计请求次数（/api/log/self 分页 total）
    pub request_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPayload {
    pub connected: bool,
    pub stats: Option<NewApiWalletStats>,
}

/// API 密钥页：未接入时 connected=false
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysPayload {
    pub connected: bool,
    pub items: Vec<NewApiTokenInfo>,
}

/// 兑换码结果：本次到账额度 + 兑换后的最新余额
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiRedeemResult {
    pub granted_quota: i64,
    pub balance_quota: i64,
    pub used_quota: i64,
    pub quota_per_unit: f64,
}

/// 仪表盘汇总：余额（/api/user/self）+ 今日 / 本周 / 本月消耗（/api/data/self）。
///
/// 本周窗口一次拉取后按当日零点过滤出今日；本月跨 30 天时自动分段。
/// 聚合接口不可用时整体降级到统计接口（仅金额，token 计为 0 由前端显示 —）。
pub fn usage_summary(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<NewApiUsageSummary, CoreError> {
    if access_token.trim().is_empty() {
        return Err(CoreError::InvalidData("访问令牌不能为空".into()));
    }
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("站点地址不能为空".into()));
    }
    let client = build_client(timeout)?;

    // 余额与单价
    let status_data = api_get(&client, &format!("{base}/api/status"), access_token, user_id)?;
    let system_name = status_data
        .get("system_name")
        .and_then(Value::as_str)
        .unwrap_or("NewAPI")
        .to_string();
    let quota_per_unit = status_data
        .get("quota_per_unit")
        .map(as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500_000.0);
    let user = api_get(&client, &format!("{base}/api/user/self"), access_token, user_id)?;
    let balance_quota = user.get("quota").map(as_i64).unwrap_or(0);
    let used_quota = user.get("used_quota").map(as_i64).unwrap_or(0);

    // 三个窗口
    let (today_start, week_start, month_start) = local_window_starts();
    let now = chrono::Utc::now().timestamp();

    let (today, week, month) = match fetch_window(&client, &base, access_token, user_id, week_start, now) {
        Ok(week_window) => {
            // 本周数据里按当日零点过滤出今日
            let today_window = fetch_window(&client, &base, access_token, user_id, today_start, now)
                .unwrap_or_default();
            let month_window = fetch_window(&client, &base, access_token, user_id, month_start, now)
                .unwrap_or_default();
            (today_window, week_window, month_window)
        }
        Err(first_error) => {
            // 降级：统计接口只有金额
            let fallback = |start: i64| -> NewApiUsageWindow {
                NewApiUsageWindow {
                    quota: stat_window_quota(&client, &base, access_token, user_id, start, now)
                        .unwrap_or(0),
                    tokens: 0,
                }
            };
            let _ = first_error;
            (
                fallback(today_start),
                fallback(week_start),
                fallback(month_start),
            )
        }
    };

    Ok(NewApiUsageSummary {
        system_name,
        balance_quota,
        used_quota,
        quota_per_unit,
        today,
        week,
        month,
    })
}

// ---------------------------------------------------------------------------
// 钱包
// ---------------------------------------------------------------------------

/// 钱包统计：余额 / 总用量（/api/user/self）+ API 请求数（/api/log/self 分页 total）
pub fn wallet_stats(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    timeout: Duration,
) -> Result<NewApiWalletStats, CoreError> {
    if access_token.trim().is_empty() {
        return Err(CoreError::InvalidData("访问令牌不能为空".into()));
    }
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err(CoreError::InvalidData("站点地址不能为空".into()));
    }
    let client = build_client(timeout)?;

    let status_data = api_get(&client, &format!("{base}/api/status"), access_token, user_id)?;
    let system_name = status_data
        .get("system_name")
        .and_then(Value::as_str)
        .unwrap_or("NewAPI")
        .to_string();
    let quota_per_unit = status_data
        .get("quota_per_unit")
        .map(as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500_000.0);

    let user = api_get(&client, &format!("{base}/api/user/self"), access_token, user_id)?;
    let balance_quota = user.get("quota").map(as_i64).unwrap_or(0);
    let used_quota = user.get("used_quota").map(as_i64).unwrap_or(0);

    // 取 1 条日志只为拿分页 total = 累计请求数
    let logs_url = format!("{base}/api/log/self?p=1&size=1");
    let logs = api_get(&client, &logs_url, access_token, user_id)?;
    let request_count = logs.get("total").map(as_i64).unwrap_or(0);

    Ok(NewApiWalletStats {
        system_name,
        username: user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        balance_quota,
        used_quota,
        quota_per_unit,
        request_count,
    })
}

/// 兑换码兑换：POST /api/user/topup {"key": code}，成功返回本次到账 quota；
/// 随后回查余额供页面立即刷新。
pub fn redeem_code(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    code: &str,
    timeout: Duration,
) -> Result<NewApiRedeemResult, CoreError> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err(CoreError::InvalidData("兑换码不能为空".into()));
    }
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;

    let url = format!("{base}/api/user/topup");
    let response = authed_request(
        &client,
        reqwest::Method::POST,
        &url,
        access_token,
        user_id,
    )
    .json(&json!({ "key": code }))
    .send()
    .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    let granted_quota = as_i64(&parse_envelope(status, &body_text, &url)?);

    // quota_per_unit 在 /api/status；余额回查用 /api/user/self
    let status_data = api_get(&client, &format!("{base}/api/status"), access_token, user_id)?;
    let quota_per_unit = status_data
        .get("quota_per_unit")
        .map(as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500_000.0);
    let user = api_get(&client, &format!("{base}/api/user/self"), access_token, user_id)?;
    Ok(NewApiRedeemResult {
        granted_quota,
        balance_quota: user.get("quota").map(as_i64).unwrap_or(0),
        used_quota: user.get("used_quota").map(as_i64).unwrap_or(0),
        quota_per_unit,
    })
}

// ---------------------------------------------------------------------------
// API 密钥管理 / 使用日志
// ---------------------------------------------------------------------------

/// 删除令牌：DELETE /api/token/{id}
pub fn delete_token(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    id: i64,
    timeout: Duration,
) -> Result<(), CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let url = format!("{base}/api/token/{id}");
    let response = authed_request(
        &client,
        reqwest::Method::DELETE,
        &url,
        access_token,
        user_id,
    )
    .send()
    .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    parse_envelope(status, &body_text, &url)?;
    Ok(())
}

/// 启用 / 禁用令牌：PUT /api/token/?status_only=true（服务端只取 id + status，不动其他字段）
pub fn set_token_status(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    id: i64,
    status: i64,
    timeout: Duration,
) -> Result<(), CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let url = format!("{base}/api/token/?status_only=true");
    let response = authed_request(
        &client,
        reqwest::Method::PUT,
        &url,
        access_token,
        user_id,
    )
    .json(&json!({ "id": id, "status": status }))
    .send()
    .map_err(|e| CoreError::OperationFailed(format!("请求失败（{url}）：{e}")))?;
    let status_code = response.status();
    let body_text = response.text().unwrap_or_default();
    parse_envelope(status_code, &body_text, &url)?;
    Ok(())
}

/// 使用日志条目（消费日志含模型 / 令牌 / token 数 / 金额 / 耗时）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiLogEntry {
    pub id: i64,
    pub created_at: i64,
    /// 0=其他 1=充值 2=消费 3=管理 4=系统 5=错误 6=退款 7=登录
    pub log_type: i64,
    pub content: String,
    pub model_name: String,
    pub token_name: String,
    pub quota: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub use_time: i64,
    pub is_stream: bool,
    /// 首响毫秒数（other.frt）；非流式与缺失时站点用 -1000 哨兵，此处归一为负数=无
    pub frt_ms: i64,
    /// 缓存命中 token 数（other.cache_tokens，已含在 prompt_tokens 内），0=无
    pub cache_tokens: i64,
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiLogsPayload {
    pub items: Vec<NewApiLogEntry>,
    pub total: i64,
}

/// 分页拉取使用日志：/api/log/self（log_type / start / end 传 0 表示不过滤）
pub fn list_logs(
    base_url: &str,
    access_token: &str,
    user_id: Option<i64>,
    page: i64,
    page_size: i64,
    log_type: i64,
    start: i64,
    end: i64,
    timeout: Duration,
) -> Result<NewApiLogsPayload, CoreError> {
    let base = normalize_base(base_url);
    let client = build_client(timeout)?;
    let url = format!(
        "{base}/api/log/self?p={}&size={}&type={}&start_timestamp={}&end_timestamp={}",
        page.max(1),
        page_size.clamp(1, 100),
        log_type,
        start,
        end
    );
    let data = api_get(&client, &url, access_token, user_id)?;
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = data.get("total").map(as_i64).unwrap_or(0);
    Ok(NewApiLogsPayload {
        total,
        items: items
            .iter()
            .map(|item| {
                let other_object = parse_other_object(item.get("other"));
                NewApiLogEntry {
                id: item.get("id").map(as_i64).unwrap_or(0),
                created_at: item.get("created_at").map(as_i64).unwrap_or(0),
                log_type: item.get("type").map(as_i64).unwrap_or(0),
                content: item
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                model_name: item
                    .get("model_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                token_name: item
                    .get("token_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                quota: item.get("quota").map(as_i64).unwrap_or(0),
                prompt_tokens: item.get("prompt_tokens").map(as_i64).unwrap_or(0),
                completion_tokens: item.get("completion_tokens").map(as_i64).unwrap_or(0),
                use_time: item.get("use_time").map(as_i64).unwrap_or(0),
                is_stream: item
                    .get("is_stream")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                frt_ms: parse_frt_ms(&other_object),
                cache_tokens: other_object
                    .get("cache_tokens")
                    .map(as_i64)
                    .unwrap_or(0),
                group: item
                    .get("group")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                }
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// aispot 实测：新版 new-api 列表类接口 data 为 PageInfo 分页对象
    #[test]
    fn envelope_items_accepts_page_info_object() {
        let data: Value = serde_json::json!({
            "page": 1, "page_size": 100, "total": 2,
            "items": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}],
        });
        let items = envelope_items(&data);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].get("name").and_then(Value::as_str), Some("a"));
    }

    /// 旧版 new-api / one-api 的 data 直接是数组
    #[test]
    fn envelope_items_accepts_plain_array() {
        let data: Value = serde_json::json!([{"id": 7, "name": "x"}]);
        assert_eq!(envelope_items(&data).len(), 1);
        assert_eq!(envelope_items(&Value::Null).len(), 0);
        assert_eq!(envelope_items(&serde_json::json!({"total": 3})).len(), 0);
    }

    /// aispot 实测：/api/user/groups 新版返回 分组名 -> 分组对象（含 ratio/base_ratio/desc）
    #[test]
    fn group_map_values_accept_ratio_objects() {
        let data: Value = serde_json::json!({
            "ccmax": {"base_ratio": 1.2, "desc": "满血", "ratio": 1.2, "has_user_ratio": false},
            "数字倍率": 0.5,
        });
        let mut groups: Vec<NewApiGroupInfo> = Vec::new();
        if let Value::Object(map) = &data {
            for (name, value) in map {
                let ratio = value
                    .get("ratio")
                    .or_else(|| value.get("base_ratio"))
                    .and_then(Value::as_f64)
                    .or_else(|| value.as_f64());
                if let Some(ratio) = ratio {
                    groups.push(NewApiGroupInfo {
                        name: name.clone(),
                        ratio,
                    });
                }
            }
        }
        assert_eq!(groups.len(), 2);
        let numeric = groups.iter().find(|g| g.name == "数字倍率").unwrap();
        assert!((numeric.ratio - 0.5).abs() < f64::EPSILON);
        let obj = groups.iter().find(|g| g.name == "ccmax").unwrap();
        assert!((obj.ratio - 1.2).abs() < f64::EPSILON);
    }

    /// 令牌失效识别：英文（aispot 实测原文）与常见中文文案都要命中
    #[test]
    fn invalid_token_message_matches_known_wordings() {
        assert!(is_invalid_token_message(
            "Unauthorized, invalid access token"
        ));
        assert!(is_invalid_token_message("无效的访问令牌"));
        assert!(is_invalid_token_message("该令牌已失效，请重新登录"));
        // New-Api-User 头缺失指引与普通业务错误不应误判
        assert!(!is_invalid_token_message(NEW_API_USER_GUIDANCE));
        assert!(!is_invalid_token_message("余额不足"));
        assert!(!is_invalid_token_message("无权进行此操作，未登录且未提供 access token"));
    }

    /// aispot 实测形态：HTTP 200 + success:false + 失效文案 → SiteTokenInvalid
    #[test]
    fn parse_envelope_tags_invalid_token_http200() {
        let body = r#"{"message":"Unauthorized, invalid access token","success":false}"#;
        let err = parse_envelope(reqwest::StatusCode::OK, body, "http://site/api/user/self")
            .err()
            .expect("should fail");
        assert!(
            err.to_string().contains("站点访问令牌无效或已失效"),
            "unexpected error: {err}"
        );
    }

    /// 部分版本对无效令牌回 HTTP 401，同样要归类为 SiteTokenInvalid
    #[test]
    fn parse_envelope_tags_invalid_token_http401() {
        let body = r#"{"message":"无效的访问令牌","success":false}"#;
        let err = parse_envelope(
            reqwest::StatusCode::UNAUTHORIZED,
            body,
            "http://site/api/user/self",
        )
        .err()
        .expect("should fail");
        assert!(err.to_string().contains("站点访问令牌无效或已失效"));
    }
}
