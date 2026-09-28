use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CustomInstructionProtectionState {
    Ready,
    Unmanaged,
    Protected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CustomInstructionHistoryAction {
    Apply,
    Clear,
    Rollback,
}

// ---------------------------------------------------------------------------
// Core data structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreWarning {
    pub code: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// App settings (面板自身设置，存 ~/.zcode/zmate/settings.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// 写入 ZCode 配置前是否检查 ZCode 是否正在运行（运行中给出提示）。
    pub check_zcode_running: bool,
    /// 站点接入：new-api 站点地址（空 = 未接入）。
    pub site_base_url: String,
    /// 站点接入：系统访问令牌。仅存本机 settings.json，不回传前端展示。
    pub site_access_token: String,
    /// 站点接入：令牌归属的用户 ID（新版 new-api 的 New-Api-User 头必需；0 = 未知）。
    pub site_user_id: i64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            check_zcode_running: true,
            site_base_url: String::new(),
            site_access_token: String::new(),
            site_user_id: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// MCP payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub transport: McpTransport,
    pub enabled: bool,
    pub source_path: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub environment: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerListPayload {
    pub items: Vec<McpServerSummary>,
    pub total: i32,
    pub source_path: String,
    pub last_scan_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerMutationPayload {
    pub server: McpServerSummary,
    pub total: i32,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRemovePayload {
    pub removed_name: String,
    pub total: i32,
    pub source_path: String,
}

// ---------------------------------------------------------------------------
// Skill payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkillSummary {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub relative_path: String,
    pub directory_path: String,
    pub skill_file_path: String,
    pub updated_at: Option<i64>,
}

impl InstalledSkillSummary {
    pub fn display_title(&self) -> &str {
        match &self.title {
            Some(t) if !t.is_empty() => t.as_str(),
            _ => &self.name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillListPayload {
    pub items: Vec<InstalledSkillSummary>,
    pub total: i32,
    pub root_path: String,
    pub last_scan_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillBackupSummary {
    pub id: String,
    #[serde(rename = "skillID")]
    pub skill_id: String,
    pub name: String,
    pub title: Option<String>,
    pub relative_path: String,
    pub backup_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillBackupListPayload {
    pub items: Vec<SkillBackupSummary>,
    pub total: i32,
    pub root_path: String,
    pub last_scan_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportPayload {
    pub skill: InstalledSkillSummary,
    pub replaced_existing: bool,
    pub backup: Option<SkillBackupSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemovePayload {
    #[serde(rename = "removedSkillID")]
    pub removed_skill_id: String,
    pub backup: SkillBackupSummary,
    pub remaining_installed_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRestorePayload {
    pub restored_skill: InstalledSkillSummary,
    pub backup: SkillBackupSummary,
    pub rollback_backup: Option<SkillBackupSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDeleteBackupPayload {
    #[serde(rename = "deletedBackupID")]
    pub deleted_backup_id: String,
    pub remaining_backup_count: i32,
}

// ---------------------------------------------------------------------------
// Custom instruction payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomInstructionCurrentState {
    pub global_path: String,
    pub file_exists: bool,
    pub managed_block_present: bool,
    pub protection_state: CustomInstructionProtectionState,
    pub issue_message: Option<String>,
    pub managed_content: String,
    pub last_applied_at: Option<i64>,
    pub last_template_code: Option<String>,
    pub last_template_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomInstructionHistoryEntry {
    pub id: String,
    pub created_at: i64,
    pub action: CustomInstructionHistoryAction,
    pub source: String,
    pub template_code: Option<String>,
    pub template_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomInstructionStatePayload {
    pub current: CustomInstructionCurrentState,
    pub history: Vec<CustomInstructionHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomInstructionPreviewPayload {
    pub global_path: String,
    pub protection_state: CustomInstructionProtectionState,
    pub issue_message: Option<String>,
    pub current_managed_content: String,
    pub next_managed_content: String,
    pub resulting_content: String,
}

// ---------------------------------------------------------------------------
// System payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallabilityPayload {
    pub can_install: bool,
    pub code: String,
    pub executable_path: Option<String>,
    pub bundle_path: Option<String>,
    pub translocated: bool,
    pub quarantined: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosePathCheck {
    pub key: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosePayload {
    pub zcode_home: String,
    pub core_version: String,
    pub os: String,
    pub arch: String,
    pub zcode_running: bool,
    pub path_checks: Vec<DiagnosePathCheck>,
    pub provider_config_valid: bool,
    pub provider_config_error: Option<String>,
    pub cli_config_valid: bool,
    pub cli_config_error: Option<String>,
    pub session_db_exists: bool,
    pub tasks_db_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeProxyPayload {
    /// setting.json 里 httpProxy 非空即视为启用
    pub enabled: bool,
    /// 本机代理端口（host 为 127.0.0.1/localhost 且端口可解析时才有值）
    pub port: Option<String>,
    /// setting.json 里的原始 httpProxy 值
    pub proxy_url: Option<String>,
    /// 代理地址是否指向本机
    pub is_local: bool,
    pub source_path: String,
}

/// 站点连接状态（登录令牌页）；访问令牌绝不回传前端
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteConnectionStatusPayload {
    pub connected: bool,
    pub base_url: String,
}

/// 用已存储的连接做一次真实校验的结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteVerifyPayload {
    pub ok: bool,
    pub system_name: String,
    pub username: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanPayload {
    pub provider_backups_removed: i32,
    pub skill_backups_removed: i32,
    pub instruction_history_removed: i32,
}

// ---------------------------------------------------------------------------
// Generic envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreEnvelope<T: Serialize> {
    pub schema_version: i32,
    pub success: bool,
    pub code: String,
    pub message: String,
    pub warnings: Vec<CoreWarning>,
    pub data: T,
}

impl<T: Serialize> CoreEnvelope<T> {
    pub fn ok(data: T) -> Self {
        Self {
            schema_version: 1,
            success: true,
            code: "ok".to_string(),
            message: "Success".to_string(),
            warnings: vec![],
            data,
        }
    }

    pub fn ok_with_warnings(data: T, warnings: Vec<CoreWarning>) -> Self {
        Self {
            schema_version: 1,
            success: true,
            code: "ok".to_string(),
            message: "Success".to_string(),
            warnings,
            data,
        }
    }

    pub fn error(code: &str, message: &str, data: T) -> Self {
        Self {
            schema_version: 1,
            success: false,
            code: code.to_string(),
            message: message.to_string(),
            warnings: vec![],
            data,
        }
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),

    #[error("Operation failed: {0}")]
    OperationFailed(String),

    /// 站点明确拒绝了访问令牌（存储连接已失效）——前端据此自动退回未登录态
    #[error("站点访问令牌无效或已失效：{0}")]
    SiteTokenInvalid(String),
}

impl Serialize for CoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 当前时间（epoch 毫秒），各模块通用。
pub fn current_timestamp() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
