use crate::core::models::CoreEnvelope;
use crate::core::site_direct as site_direct_core;
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn site_direct_status(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<site_direct_core::SiteDirectStatus>, String> {
    let payload = site_direct_core::load_status(&paths).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub async fn site_direct_ping(
    label: String,
    origin: String,
) -> Result<CoreEnvelope<site_direct_core::SiteDirectPing>, String> {
    let ping = tauri::async_runtime::spawn_blocking(move || {
        site_direct_core::ping_target(&label, &origin)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(ping))
}

#[tauri::command]
pub fn site_direct_apply(
    paths: State<'_, Arc<ZCodePaths>>,
    target_origin: String,
) -> Result<CoreEnvelope<site_direct_core::SiteDirectApplyReport>, String> {
    let payload = site_direct_core::apply_origin(&paths, &target_origin).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}
