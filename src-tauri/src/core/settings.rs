use crate::core::models::{AppSettings, CoreError};
use crate::platform::paths::ZCodePaths;

/// 面板自身设置读写。解析失败静默回默认（容错优先），写入为原子写。
pub fn load_settings(paths: &ZCodePaths) -> AppSettings {
    match std::fs::read_to_string(&paths.settings_path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(paths: &ZCodePaths, settings: &AppSettings) -> Result<(), CoreError> {
    paths.ensure_app_directories()?;
    let tmp = paths.settings_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    std::fs::rename(&tmp, &paths.settings_path)?;
    Ok(())
}
