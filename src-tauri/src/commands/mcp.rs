use crate::core::mcp::{self, McpServerInput};
use crate::core::models::{
    CoreEnvelope, McpServerListPayload, McpServerMutationPayload, McpServerRemovePayload,
    McpTransport,
};
use crate::platform::paths::ZCodePaths;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

fn transport_from_str(value: &str) -> Result<McpTransport, String> {
    match value {
        "stdio" => Ok(McpTransport::Stdio),
        "http" => Ok(McpTransport::Http),
        "sse" => Ok(McpTransport::Sse),
        other => Err(format!("未知 transport 类型：{other}")),
    }
}

#[tauri::command]
pub fn load_mcp_servers(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<McpServerListPayload>, String> {
    mcp::load_mcp_servers(&paths)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_mcp_server(
    paths: State<'_, Arc<ZCodePaths>>,
    name: String,
    transport: String,
    enabled: bool,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
    environment: Option<HashMap<String, String>>,
) -> Result<CoreEnvelope<McpServerMutationPayload>, String> {
    let input = McpServerInput {
        name,
        transport: transport_from_str(&transport)?,
        enabled,
        command,
        args: args.unwrap_or_default(),
        url,
        headers: headers.unwrap_or_default(),
        environment: environment.unwrap_or_default(),
    };
    mcp::upsert_mcp_server(&paths, input)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_mcp_server_enabled(
    paths: State<'_, Arc<ZCodePaths>>,
    name: String,
    enabled: bool,
) -> Result<CoreEnvelope<McpServerMutationPayload>, String> {
    mcp::set_mcp_server_enabled(&paths, &name, enabled)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_mcp_server(
    paths: State<'_, Arc<ZCodePaths>>,
    name: String,
) -> Result<CoreEnvelope<McpServerRemovePayload>, String> {
    mcp::remove_mcp_server(&paths, &name)
        .map(CoreEnvelope::ok)
        .map_err(|e| e.to_string())
}
