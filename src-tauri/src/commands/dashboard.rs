use crate::core::dashboard;
use crate::core::models::CoreEnvelope;
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn load_dashboard(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<dashboard::DashboardPayload>, String> {
    dashboard::load_dashboard(&paths)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}
