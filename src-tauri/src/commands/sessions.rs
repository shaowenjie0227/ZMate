use crate::core::models::CoreEnvelope;
use crate::core::session_transfer::{
    self, TransferExportPayload, TransferImportPayload, TransferPreviewPayload,
};
use crate::core::sessions::{
    self, SessionDetailPayload, SessionListPayload, SessionOverviewPayload, SessionStatsPayload,
};
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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

// ---------------------------------------------------------------------------
// 会话迁移（导出 zip / 导入 zip）
// ---------------------------------------------------------------------------

/// 进度事件名：stage = "backup" | "export" | "import"。
const TRANSFER_PROGRESS_EVENT: &str = "session-transfer-progress";

#[tauri::command]
pub async fn export_sessions(
    app: AppHandle,
    paths: State<'_, Arc<ZCodePaths>>,
    task_ids: Vec<String>,
    out_path: String,
) -> Result<CoreEnvelope<TransferExportPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let handle = app;
        session_transfer::export_sessions(
            &paths,
            &task_ids,
            std::path::Path::new(&out_path),
            Some(&|stage, done, total| {
                let _ = handle.emit(
                    TRANSFER_PROGRESS_EVENT,
                    serde_json::json!({ "stage": stage, "done": done, "total": total }),
                );
            }),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub async fn inspect_session_zip(
    paths: State<'_, Arc<ZCodePaths>>,
    zip_path: String,
) -> Result<CoreEnvelope<TransferPreviewPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        session_transfer::inspect_session_zip(&paths, std::path::Path::new(&zip_path))
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub async fn import_sessions(
    app: AppHandle,
    paths: State<'_, Arc<ZCodePaths>>,
    zip_path: String,
    mode: Option<String>,
) -> Result<CoreEnvelope<TransferImportPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let handle = app;
        session_transfer::import_sessions(
            &paths,
            std::path::Path::new(&zip_path),
            session_transfer::ImportMode::parse(mode.as_deref()),
            Some(&|stage, done, total| {
                let _ = handle.emit(
                    TRANSFER_PROGRESS_EVENT,
                    serde_json::json!({ "stage": stage, "done": done, "total": total }),
                );
            }),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}
