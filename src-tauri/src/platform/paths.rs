use std::path::PathBuf;

/// ZCode 本地数据路径的唯一真相源。
///
/// ZCode 的数据布局（已在本机 0.16.9 验证）：
/// - `v2/provider_config.json`  自定义模型供应商配置（面板注入的目标）
/// - `v2/setting.json`          桌面端设置（httpProxy 等网络配置）
/// - `cli/config.json`          CLI 用户配置（mcp.servers / hooks / plugins）
/// - `skills/`                  用户级 Skills
/// - `AGENTS.md`                用户级指令文件
/// - `v2/tasks-index.sqlite`    会话/任务索引（tasks 表）
/// - `cli/db/db.sqlite`         会话正文（session/message/part，外键级联）
/// - `cli/rollout/`             模型 I/O 日志（非权威正文）
/// - `v2/credentials.json`      凭据（本面板绝不读写）
#[derive(Clone)]
pub struct ZCodePaths {
    pub zcode_home: PathBuf,
    pub provider_config_path: PathBuf,
    pub desktop_setting_path: PathBuf,
    pub cli_config_path: PathBuf,
    pub skills_dir: PathBuf,
    pub agents_md_path: PathBuf,
    pub tasks_db_path: PathBuf,
    pub session_db_path: PathBuf,
    pub rollout_dir: PathBuf,
    pub credentials_path: PathBuf,

    /// 面板自身数据区（备份 / 历史 / 设置），不碰 ZCode 数据。
    pub app_data_dir: PathBuf,
    pub skill_backups_dir: PathBuf,
    pub provider_config_backups_dir: PathBuf,
    pub custom_instruction_history_dir: PathBuf,
    pub settings_path: PathBuf,
}

impl ZCodePaths {
    pub fn new() -> Self {
        Self::from_home(Self::resolve_zcode_home())
    }

    pub fn from_home(zcode_home: PathBuf) -> Self {
        let app_data_dir = zcode_home.join("zmate");
        Self {
            provider_config_path: zcode_home.join("v2").join("provider_config.json"),
            desktop_setting_path: zcode_home.join("v2").join("setting.json"),
            cli_config_path: zcode_home.join("cli").join("config.json"),
            skills_dir: zcode_home.join("skills"),
            agents_md_path: zcode_home.join("AGENTS.md"),
            tasks_db_path: zcode_home.join("v2").join("tasks-index.sqlite"),
            session_db_path: zcode_home.join("cli").join("db").join("db.sqlite"),
            rollout_dir: zcode_home.join("cli").join("rollout"),
            credentials_path: zcode_home.join("v2").join("credentials.json"),
            skill_backups_dir: app_data_dir.join("skill-backups"),
            provider_config_backups_dir: app_data_dir.join("backups").join("provider-config"),
            custom_instruction_history_dir: app_data_dir.join("custom-instructions").join("history"),
            settings_path: app_data_dir.join("settings.json"),
            app_data_dir,
            zcode_home,
        }
    }

    fn resolve_zcode_home() -> PathBuf {
        if let Ok(val) = std::env::var("ZCODE_HOME") {
            return PathBuf::from(val);
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".zcode")
    }

    pub fn ensure_app_directories(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.app_data_dir)?;
        std::fs::create_dir_all(&self.skill_backups_dir)?;
        std::fs::create_dir_all(&self.provider_config_backups_dir)?;
        std::fs::create_dir_all(&self.custom_instruction_history_dir)?;
        Ok(())
    }
}

impl Default for ZCodePaths {
    fn default() -> Self {
        Self::new()
    }
}
