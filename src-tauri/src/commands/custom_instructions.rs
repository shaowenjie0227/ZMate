use crate::core::custom_instructions;
use crate::core::models::{
    CoreEnvelope, CustomInstructionPreviewPayload, CustomInstructionStatePayload,
};
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn load_custom_instruction_state(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<CustomInstructionStatePayload>, String> {
    let payload = custom_instructions::load_state(&paths).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn preview_custom_instruction_apply(
    paths: State<'_, Arc<ZCodePaths>>,
    content: String,
) -> Result<CoreEnvelope<CustomInstructionPreviewPayload>, String> {
    let payload =
        custom_instructions::preview_apply(&paths, &content).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn apply_custom_instruction(
    paths: State<'_, Arc<ZCodePaths>>,
    content: String,
    template_code: Option<String>,
    template_title: Option<String>,
    source: Option<String>,
) -> Result<CoreEnvelope<CustomInstructionStatePayload>, String> {
    let payload = custom_instructions::apply_managed_content(
        &paths,
        &content,
        template_code,
        template_title,
        source,
    )
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn clear_custom_instruction_block(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<CustomInstructionStatePayload>, String> {
    let payload =
        custom_instructions::clear_managed_block(&paths).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub fn rollback_custom_instruction(
    paths: State<'_, Arc<ZCodePaths>>,
    history_id: String,
) -> Result<CoreEnvelope<CustomInstructionStatePayload>, String> {
    let payload =
        custom_instructions::rollback_history(&paths, &history_id).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(payload))
}
