use crate::core::models::CoreEnvelope;
use crate::core::sessions::{
    self, SessionDetailPayload, SessionListPayload, SessionOverviewPayload, SessionStatsPayload,
};
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_session_overview(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SessionOverviewPayload>, String> {
    sessions::get_session_overview(&paths)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions(
    paths: State<'_, Arc<ZCodePaths>>,
    query: Option<String>,
    include_archived: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<CoreEnvelope<SessionListPayload>, String> {
    sessions::list_sessions(
        &paths,
        query.as_deref(),
        include_archived.unwrap_or(false),
        limit.unwrap_or(50).clamp(1, 500),
        offset.unwrap_or(0).max(0),
    )
    .map(CoreEnvelope::ok)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_detail(
    paths: State<'_, Arc<ZCodePaths>>,
    task_id: String,
) -> Result<CoreEnvelope<SessionDetailPayload>, String> {
    sessions::get_session_detail(&paths, &task_id, 4000)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_stats(
    paths: State<'_, Arc<ZCodePaths>>,
    task_id: String,
) -> Result<CoreEnvelope<SessionStatsPayload>, String> {
    sessions::get_session_stats(&paths, &task_id)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}
