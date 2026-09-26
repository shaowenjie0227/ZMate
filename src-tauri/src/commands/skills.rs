use crate::core::models::{
    CoreEnvelope, SkillBackupListPayload, SkillDeleteBackupPayload, SkillImportPayload,
    SkillListPayload, SkillRemovePayload, SkillRestorePayload,
};
use crate::core::skills;
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn load_installed_skills(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SkillListPayload>, String> {
    let items = skills::load_installed_skills(&paths.skills_dir).map_err(|e| e.to_string())?;
    let payload = SkillListPayload {
        total: items.len() as i32,
        root_path: paths.skills_dir.to_string_lossy().to_string(),
        items,
        last_scan_at: crate::core::models::current_timestamp(),
    };
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn load_skill_backups(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SkillBackupListPayload>, String> {
    let items =
        skills::load_skill_backups(&paths.skill_backups_dir).map_err(|e| e.to_string())?;
    let payload = SkillBackupListPayload {
        total: items.len() as i32,
        root_path: paths.skill_backups_dir.to_string_lossy().to_string(),
        items,
        last_scan_at: crate::core::models::current_timestamp(),
    };
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn import_skill(
    paths: State<'_, Arc<ZCodePaths>>,
    source_path: String,
) -> Result<CoreEnvelope<SkillImportPayload>, String> {
    paths.ensure_app_directories().map_err(|e| e.to_string())?;
    let payload = skills::import_skill(&paths.skills_dir, &paths.skill_backups_dir, &source_path)
        .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn remove_skill(
    paths: State<'_, Arc<ZCodePaths>>,
    skill_id: String,
) -> Result<CoreEnvelope<SkillRemovePayload>, String> {
    paths.ensure_app_directories().map_err(|e| e.to_string())?;
    let payload = skills::remove_skill(&paths.skills_dir, &paths.skill_backups_dir, &skill_id)
        .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn restore_skill_backup(
    paths: State<'_, Arc<ZCodePaths>>,
    backup_id: String,
) -> Result<CoreEnvelope<SkillRestorePayload>, String> {
    let payload = skills::restore_skill_backup(
        &paths.skills_dir,
        &paths.skill_backups_dir,
        &backup_id,
    )
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn delete_skill_backup(
    paths: State<'_, Arc<ZCodePaths>>,
    backup_id: String,
) -> Result<CoreEnvelope<SkillDeleteBackupPayload>, String> {
    let payload =
        skills::delete_skill_backup(&paths.skill_backups_dir, &backup_id)
            .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}
