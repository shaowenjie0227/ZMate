use crate::core::models::CoreEnvelope;
use crate::core::providers::{
    self, ProviderConnectivityPayload, ProviderModelsPayload, ProviderModelTestPayload,
    ProviderMutationPayload, ProviderRemovePayload, ProviderStatePayload, ProviderStreamTestPayload,
    ProviderUpsertInput,
};
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn parse_api_type(value: &str) -> Result<providers::ProviderApiType, String> {
    match value {
        "openai-responses" => Ok(providers::ProviderApiType::OpenaiResponses),
        "openai-chat-completions" => Ok(providers::ProviderApiType::OpenaiChatCompletions),
        "anthropic-messages" => Ok(providers::ProviderApiType::AnthropicMessages),
        other => Err(format!("未知协议类型：{other}")),
    }
}

#[tauri::command]
pub fn load_providers(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<ProviderStatePayload>, String> {
    providers::load_provider_state(&paths)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_provider_models(
    api_type: String,
    base_url: String,
    api_key: String,
) -> Result<CoreEnvelope<ProviderModelsPayload>, String> {
    let api_type = parse_api_type(&api_type)?;
    let items = tauri::async_runtime::spawn_blocking(move || {
        providers::fetch_provider_models(
            api_type,
            &base_url,
            &api_key,
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(ProviderModelsPayload { items }))
}

#[tauri::command]
pub async fn test_provider_connectivity(
    api_type: String,
    base_url: String,
    api_key: String,
) -> Result<CoreEnvelope<ProviderConnectivityPayload>, String> {
    let api_type = parse_api_type(&api_type)?;
    let payload = tauri::async_runtime::spawn_blocking(move || {
        providers::test_provider_connectivity(
            api_type,
            &base_url,
            &api_key,
            std::time::Duration::from_secs(10),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub async fn test_provider(
    paths: State<'_, Arc<ZCodePaths>>,
    provider_id: String,
) -> Result<CoreEnvelope<ProviderConnectivityPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        providers::test_saved_provider(&paths, &provider_id)
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

/// 模型实测：按协议向注入的模型发一条最小推理请求（对应原版 AiMaMi 的模型测试）
#[tauri::command]
pub async fn test_provider_model(
    paths: State<'_, Arc<ZCodePaths>>,
    provider_id: String,
    model_id: String,
) -> Result<CoreEnvelope<ProviderModelTestPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        providers::test_provider_model(&paths, &provider_id, &model_id)
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

/// 流式连通性测试：真实流式推理请求，分阶段通过事件推送给前端（对应原版 AiMaMi 的连通性测试）
#[tauri::command]
pub async fn stream_test_provider_model(
    app: AppHandle,
    paths: State<'_, Arc<ZCodePaths>>,
    provider_id: String,
    model_id: String,
) -> Result<CoreEnvelope<ProviderStreamTestPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let handle = app;
        providers::stream_test_provider_model(&paths, &provider_id, &model_id, &|stage, status, elapsed| {
            let _ = handle.emit(
                "provider-stream-test-progress",
                serde_json::json!({
                    "providerId": provider_id,
                    "modelId": model_id,
                    "stage": stage,
                    "statusCode": status,
                    "elapsedMs": elapsed,
                }),
            );
        })
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn upsert_provider(
    paths: State<'_, Arc<ZCodePaths>>,
    input: ProviderUpsertInput,
) -> Result<CoreEnvelope<ProviderMutationPayload>, String> {
    providers::upsert_provider(&paths, &input)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_provider(
    paths: State<'_, Arc<ZCodePaths>>,
    provider_id: String,
) -> Result<CoreEnvelope<ProviderRemovePayload>, String> {
    providers::remove_provider(&paths, &provider_id)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_provider_enabled(
    paths: State<'_, Arc<ZCodePaths>>,
    provider_id: String,
    enabled: bool,
) -> Result<CoreEnvelope<ProviderMutationPayload>, String> {
    providers::set_provider_enabled(&paths, &provider_id, enabled)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}
