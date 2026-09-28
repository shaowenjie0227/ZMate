//! 会话迁移：导出为 zip / 从 zip 导入。
//!
//! zip 布局（format = "zmate-sessions"，version = 1）：
//! - `manifest.json`：`{format, version, exported_at, count, app}`
//! - `sessions/<task_id>.json`：单个会话的整行快照
//!   ```json
//!   {
//!     "task_id": "sess_xxx",
//!     "tasks":     [ ... tasks-index.sqlite 的 tasks 表整行（列名→值）... ],
//!     "session":   { ... db.sqlite 的 session 表整行 ... } | null,
//!     "messages":  [ { "row": { ...message 整行... }, "parts": [ ...part 整行... ] } ],
//!     "model_usage": [ ... ], "turn_usage": [ ... ], "tool_usage": [ ... ]
//!   }
//!   ```
//!
//! 所有行都按 `SELECT *` + `PRAGMA table_info` 原样搬运（与 sessions.rs 的容错
//! 风格一致）：导出时不裁剪未知列，导入时只回插「zip 行 ∩ 本地表列」的交集，
//! 缺失列跳过，schema 漂移不会炸。BLOB 列以 `{"__blob_hex__": ...}` 十六进制编码。
//!
//! 导入会**写入** ZCode 的两个库：写之前先用只读连接 `VACUUM INTO` 把两库快照
//! 备份到 `zmate/backups/session-transfer/<时间戳>/`，然后各库单事务导入。

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value};

use crate::core::models::{current_timestamp, CoreError};
use crate::platform::paths::ZCodePaths;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

pub const TRANSFER_FORMAT: &str = "zmate-sessions";
pub const TRANSFER_VERSION: i64 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const SESSIONS_DIR: &str = "sessions/";

/// 进度回调：stage = "backup" | "export" | "import"，done/total 为会话计数。
pub type ProgressFn<'a> = &'a (dyn Fn(&str, usize, usize) + Send + Sync + 'a);

fn notify(progress: Option<ProgressFn>, stage: &str, done: usize, total: usize) {
    if let Some(f) = progress {
        f(stage, done, total);
    }
}

// ---------------------------------------------------------------------------
// 载荷结构（序列化给前端，camelCase）
// ---------------------------------------------------------------------------

/// 导出结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferExportPayload {
    pub exported: usize,
    pub missing_task_ids: Vec<String>,
    pub file_path: String,
    pub file_bytes: i64,
}

/// 导入预览里的单个会话条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreviewItem {
    pub task_id: String,
    pub title: String,
    pub workspace_path: Option<String>,
    pub updated_at: i64,
    pub message_count: usize,
    pub body_exists: bool,
    pub exists_locally: bool,
}

/// 导入预览载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreviewPayload {
    pub format: String,
    pub version: i64,
    pub exported_at: i64,
    pub total: usize,
    pub items: Vec<TransferPreviewItem>,
}

/// 导入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferImportPayload {
    pub imported: usize,
    pub skipped: usize,
    pub backup_dir: String,
}

/// zip 内 manifest.json（文件格式用 snake_case）。
#[derive(Debug, Serialize, Deserialize)]
struct TransferManifest {
    format: String,
    version: i64,
    exported_at: i64,
    count: usize,
    #[allow(dead_code)]
    app: Option<String>,
}

/// 导入冲突策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// 已存在的会话保持本地不动（默认）。
    Skip,
    /// 先删本地同 id 会话（外键级联清子行）再整行写入。
    Overwrite,
}

impl ImportMode {
    pub fn parse(mode: Option<&str>) -> Self {
        match mode.unwrap_or("skip") {
            "overwrite" => ImportMode::Overwrite,
            _ => ImportMode::Skip,
        }
    }
}

// ---------------------------------------------------------------------------
// 内部工具：SQLite 值 ↔ JSON
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// SQLite 单行值 → JSON：BLOB 用十六进制对象编码，其余直映射。
fn sqlite_to_json(value: &rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(v) => json!(v),
        rusqlite::types::Value::Real(v) => json!(v),
        rusqlite::types::Value::Text(v) => json!(v),
        rusqlite::types::Value::Blob(b) => json!({ "__blob_hex__": hex_encode(b) }),
    }
}

/// JSON → SQLite 值（sqlite_to_json 的逆运算）。
fn json_to_sql(value: &Value) -> Result<rusqlite::types::Value, CoreError> {
    match value {
        Value::Null => Ok(rusqlite::types::Value::Null),
        Value::Bool(b) => Ok(rusqlite::types::Value::Integer(*b as i64)),
        Value::Number(n) => {
            if let Some(v) = n.as_i64() {
                Ok(rusqlite::types::Value::Integer(v))
            } else if let Some(v) = n.as_f64() {
                Ok(rusqlite::types::Value::Real(v))
            } else {
                Err(CoreError::InvalidData(format!("数值超出可迁移范围: {n}")))
            }
        }
        Value::String(s) => Ok(rusqlite::types::Value::Text(s.clone())),
        // BLOB 十六进制编码的往返形式。
        Value::Object(map) if map.len() == 1 && map.contains_key("__blob_hex__") => {
            let hex = map["__blob_hex__"].as_str().unwrap_or_default();
            hex_decode(hex)
                .map(rusqlite::types::Value::Blob)
                .ok_or_else(|| CoreError::InvalidData("非法的 BLOB 十六进制编码".to_string()))
        }
        other => Err(CoreError::InvalidData(format!(
            "不支持的迁移值类型: {other}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// 内部工具：只读连接 / schema 探测 / 整行读写
// ---------------------------------------------------------------------------

fn open_read_only(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, CoreError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, CoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut cols = Vec::new();
    for row in rows {
        cols.push(row?);
    }
    Ok(cols)
}

/// `SELECT *` 整行读出为「列名→值」JSON 对象。
fn read_rows<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<JsonMap<String, Value>>, CoreError> {
    let mut stmt = conn.prepare(sql)?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut map = JsonMap::new();
        for (idx, name) in col_names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(idx)?;
            map.insert(name.clone(), sqlite_to_json(&value));
        }
        out.push(map);
    }
    Ok(out)
}

/// 排序子句容错：只在列真实存在时才参与 ORDER BY（列序即时间序兜底）。
fn order_clause(cols: &[String], has_sequence: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if cols.iter().any(|c| c == "time_created") {
        parts.push("time_created".to_string());
    }
    if has_sequence && cols.iter().any(|c| c == "sequence") {
        parts.push("COALESCE(sequence, -1)".to_string());
    }
    if cols.iter().any(|c| c == "id") {
        parts.push("id".to_string());
    }
    if parts.is_empty() {
        "rowid".to_string()
    } else {
        parts.join(", ")
    }
}

/// db.sqlite 里三张以 session_id 关联的用量表（存在且含 session_id 列才参与迁移）。
fn usage_tables(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let candidates = ["model_usage", "turn_usage", "tool_usage"];
    let mut tables = Vec::new();
    for name in candidates {
        if table_exists(conn, name)? {
            let cols = table_columns(conn, name)?;
            if cols.iter().any(|c| c == "session_id") {
                tables.push(name.to_string());
            }
        }
    }
    Ok(tables)
}

// ---------------------------------------------------------------------------
// 单会话快照（导出 / 导入共用）
// ---------------------------------------------------------------------------

/// 单个会话的整行快照。
#[derive(Debug, Clone)]
struct SessionSnapshot {
    task_id: String,
    tasks_rows: Vec<JsonMap<String, Value>>,
    session_row: Option<JsonMap<String, Value>>,
    /// message 行 → 其 part 行列表。
    messages: Vec<(JsonMap<String, Value>, Vec<JsonMap<String, Value>>)>,
    /// 表名 → 该会话的用量行。
    usage: Vec<(String, Vec<JsonMap<String, Value>>)>,
}

impl SessionSnapshot {
    fn to_json(&self) -> Value {
        json!({
            "task_id": self.task_id,
            "tasks": self.tasks_rows,
            "session": self.session_row,
            "messages": self.messages.iter().map(|(row, parts)| json!({
                "row": row,
                "parts": parts,
            })).collect::<Vec<_>>(),
            "usage": self.usage.iter().map(|(table, rows)| json!({
                "table": table,
                "rows": rows,
            })).collect::<Vec<_>>(),
        })
    }

    fn from_json(task_id: &str, value: &Value) -> Result<Self, CoreError> {
        let map = value
            .as_object()
            .ok_or_else(|| CoreError::InvalidData(format!("会话条目不是 JSON 对象: {task_id}")))?;

        let empty = Vec::new();
        let tasks_rows = map
            .get("tasks")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .map(|v| {
                v.as_object()
                    .cloned()
                    .ok_or_else(|| CoreError::InvalidData("tasks 行不是对象".to_string()))
            })
            .collect::<Result<Vec<_>, CoreError>>()?;

        let session_row = match map.get("session") {
            Some(v) if v.is_object() => Some(v.as_object().cloned().unwrap()),
            _ => None,
        };

        let mut messages = Vec::new();
        for msg in map.get("messages").and_then(Value::as_array).unwrap_or(&empty) {
            let row = msg
                .get("row")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| CoreError::InvalidData("message 行不是对象".to_string()))?;
            let parts = msg
                .get("parts")
                .and_then(Value::as_array)
                .unwrap_or(&empty)
                .iter()
                .map(|v| {
                    v.as_object()
                        .cloned()
                        .ok_or_else(|| CoreError::InvalidData("part 行不是对象".to_string()))
                })
                .collect::<Result<Vec<_>, CoreError>>()?;
            messages.push((row, parts));
        }

        let mut usage = Vec::new();
        for group in map.get("usage").and_then(Value::as_array).unwrap_or(&empty) {
            let table = group
                .get("table")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidData("usage 表名缺失".to_string()))?
                .to_string();
            // 只接受已知的三张用量表，拒绝 zip 里伪造的任意表名。
            if !["model_usage", "turn_usage", "tool_usage"].contains(&table.as_str()) {
                continue;
            }
            let rows = group
                .get("rows")
                .and_then(Value::as_array)
                .unwrap_or(&empty)
                .iter()
                .map(|v| {
                    v.as_object()
                        .cloned()
                        .ok_or_else(|| CoreError::InvalidData("usage 行不是对象".to_string()))
                })
                .collect::<Result<Vec<_>, CoreError>>()?;
            usage.push((table, rows));
        }

        Ok(SessionSnapshot {
            task_id: task_id.to_string(),
            tasks_rows,
            session_row,
            messages,
            usage,
        })
    }

    fn title(&self) -> String {
        for row in self.tasks_rows.first().into_iter().chain(self.session_row.iter()) {
            if let Some(title) = row.get("title").and_then(Value::as_str) {
                if !title.is_empty() {
                    return title.to_string();
                }
            }
        }
        self.task_id.clone()
    }

    fn updated_at(&self) -> i64 {
        self.tasks_rows
            .first()
            .and_then(|row| row.get("updated_at"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 把指定会话导出为 zip。task_ids 里在本地完全找不到（tasks 无行且无正文）的
/// 会话计入 missing_task_ids，不算失败。
pub fn export_sessions(
    paths: &ZCodePaths,
    task_ids: &[String],
    out_path: &Path,
    progress: Option<ProgressFn>,
) -> Result<TransferExportPayload, CoreError> {
    if task_ids.is_empty() {
        return Err(CoreError::InvalidData("未选择要导出的会话".to_string()));
    }
    for task_id in task_ids {
        if task_id.is_empty()
            || task_id.contains('/')
            || task_id.contains('\\')
            || task_id.contains("..")
        {
            return Err(CoreError::InvalidData(format!(
                "非法的会话 ID: {task_id}"
            )));
        }
    }

    // 索引库：不存在时按空处理（只导正文侧）。
    let tasks_conn = if paths.tasks_db_path.exists() {
        Some(open_read_only(&paths.tasks_db_path)?)
    } else {
        None
    };
    let tasks_has_table = match &tasks_conn {
        Some(conn) => table_exists(conn, "tasks")?,
        None => false,
    };

    // 正文库：不存在时 task 条目只带 tasks 行。
    let session_conn = if paths.session_db_path.exists() {
        Some(open_read_only(&paths.session_db_path)?)
    } else {
        None
    };
    let (session_tables, usage) = match &session_conn {
        Some(conn) => (
            (
                table_exists(conn, "session")?,
                table_exists(conn, "message")?,
                table_exists(conn, "part")?,
            ),
            usage_tables(conn)?,
        ),
        None => ((false, false, false), Vec::new()),
    };
    let (has_session, has_message, has_part) = session_tables;
    let message_cols = match (&session_conn, has_message) {
        (Some(conn), true) => table_columns(conn, "message")?,
        _ => Vec::new(),
    };
    let part_cols = match (&session_conn, has_part) {
        (Some(conn), true) => table_columns(conn, "part")?,
        _ => Vec::new(),
    };

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(out_path)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(false);

    let total = task_ids.len();
    let mut missing_task_ids: Vec<String> = Vec::new();
    let mut exported: usize = 0;

    for (idx, task_id) in task_ids.iter().enumerate() {
        let mut snapshot = SessionSnapshot {
            task_id: task_id.clone(),
            tasks_rows: Vec::new(),
            session_row: None,
            messages: Vec::new(),
            usage: Vec::new(),
        };

        if let Some(conn) = &tasks_conn {
            if tasks_has_table {
                snapshot.tasks_rows = read_rows(
                    conn,
                    "SELECT * FROM tasks WHERE task_id = ?1",
                    rusqlite::params![task_id],
                )?;
            }
        }

        if let Some(conn) = &session_conn {
            if has_session {
                let rows = read_rows(
                    conn,
                    "SELECT * FROM session WHERE id = ?1",
                    rusqlite::params![task_id],
                )?;
                snapshot.session_row = rows.into_iter().next();
            }
            if has_message && snapshot.session_row.is_some() {
                let order = order_clause(&message_cols, true);
                let msg_rows = read_rows(
                    conn,
                    &format!("SELECT * FROM message WHERE session_id = ?1 ORDER BY {order}"),
                    rusqlite::params![task_id],
                )?;
                for msg_row in msg_rows {
                    let mut parts = Vec::new();
                    if has_part {
                        if let Some(message_id) =
                            msg_row.get("id").and_then(Value::as_str).map(str::to_string)
                        {
                            let part_order = order_clause(&part_cols, true);
                            parts = read_rows(
                                conn,
                                &format!("SELECT * FROM part WHERE message_id = ?1 ORDER BY {part_order}"),
                                rusqlite::params![message_id],
                            )?;
                        }
                    }
                    snapshot.messages.push((msg_row, parts));
                }
            }
            if snapshot.session_row.is_some() {
                for table in &usage {
                    snapshot.usage.push((
                        table.clone(),
                        read_rows(
                            conn,
                            &format!("SELECT * FROM {table} WHERE session_id = ?1"),
                            rusqlite::params![task_id],
                        )?,
                    ));
                }
            }
        }

        if snapshot.tasks_rows.is_empty() && snapshot.session_row.is_none() {
            missing_task_ids.push(task_id.clone());
        } else {
            exported += 1;
        }

        let bytes = serde_json::to_vec_pretty(&snapshot.to_json())?;
        writer
            .start_file(format!("{SESSIONS_DIR}{task_id}.json"), options)
            .map_err(|e| CoreError::OperationFailed(format!("写入 zip 失败: {e}")))?;
        writer
            .write_all(&bytes)
            .map_err(|e| CoreError::OperationFailed(format!("写入 zip 失败: {e}")))?;
        notify(progress, "export", idx + 1, total);
    }

    let manifest = TransferManifest {
        format: TRANSFER_FORMAT.to_string(),
        version: TRANSFER_VERSION,
        exported_at: current_timestamp(),
        count: exported,
        app: Some("ZMate".to_string()),
    };
    writer
        .start_file(MANIFEST_NAME, options)
        .map_err(|e| CoreError::OperationFailed(format!("写入 zip 失败: {e}")))?;
    writer
        .write_all(&serde_json::to_vec_pretty(&manifest)?)
        .map_err(|e| CoreError::OperationFailed(format!("写入 zip 失败: {e}")))?;
    writer
        .finish()
        .map_err(|e| CoreError::OperationFailed(format!("写入 zip 失败: {e}")))?;

    let file_bytes = std::fs::metadata(out_path)?.len() as i64;
    Ok(TransferExportPayload {
        exported,
        missing_task_ids,
        file_path: out_path.display().to_string(),
        file_bytes,
    })
}

// ---------------------------------------------------------------------------
// zip 读取 / 导入预览
// ---------------------------------------------------------------------------

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, CoreError> {
    let file = std::fs::File::open(path)
        .map_err(|e| CoreError::InvalidData(format!("无法读取 zip 文件: {e}")))?;
    zip::ZipArchive::new(file)
        .map_err(|e| CoreError::InvalidData(format!("不是合法的 zip 文件: {e}")))
}

fn read_zip_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, CoreError> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| CoreError::InvalidData(format!("zip 内缺少 {name}: {e}")))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| CoreError::InvalidData(format!("读取 {name} 失败: {e}")))?;
    Ok(buf)
}

/// 列出 zip 里全部会话条目文件名（sessions/<task_id>.json），按文件名排序保证稳定。
fn list_zip_entries<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<Vec<String>, CoreError> {
    let mut names = Vec::new();
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| CoreError::InvalidData(format!("读取 zip 目录失败: {e}")))?
            .name()
            .to_string();
        if name.starts_with(SESSIONS_DIR) && name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// 解析 zip：校验 manifest、逐条解析会话快照。返回 (manifest, snapshots)。
fn parse_zip(zip_path: &Path) -> Result<(TransferManifest, Vec<SessionSnapshot>), CoreError> {
    let mut archive = open_zip(zip_path)?;
    let manifest_bytes = read_zip_entry(&mut archive, MANIFEST_NAME)?;
    let manifest: TransferManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| CoreError::InvalidData(format!("manifest.json 解析失败: {e}")))?;
    if manifest.format != TRANSFER_FORMAT {
        return Err(CoreError::InvalidData(format!(
            "不是 ZMate 会话迁移包（format={}）",
            manifest.format
        )));
    }
    if manifest.version > TRANSFER_VERSION {
        return Err(CoreError::InvalidData(format!(
            "迁移包版本过新（{} > {TRANSFER_VERSION}），请升级 ZMate",
            manifest.version
        )));
    }

    let mut snapshots = Vec::new();
    for name in list_zip_entries(&mut archive)? {
        let stem = &name[SESSIONS_DIR.len()..name.len() - ".json".len()];
        let bytes = read_zip_entry(&mut archive, &name)?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| CoreError::InvalidData(format!("{name} 解析失败: {e}")))?;
        snapshots.push(SessionSnapshot::from_json(stem, &value)?);
    }
    Ok((manifest, snapshots))
}

/// 解析迁移包并比对本地状态，生成导入预览（不做任何写入）。
pub fn inspect_session_zip(
    paths: &ZCodePaths,
    zip_path: &Path,
) -> Result<TransferPreviewPayload, CoreError> {
    let (manifest, snapshots) = parse_zip(zip_path)?;

    let tasks_conn = if paths.tasks_db_path.exists() {
        Some(open_read_only(&paths.tasks_db_path)?)
    } else {
        None
    };
    let tasks_has_table = match &tasks_conn {
        Some(conn) => table_exists(conn, "tasks")?,
        None => false,
    };
    let session_conn = if paths.session_db_path.exists() {
        Some(open_read_only(&paths.session_db_path)?)
    } else {
        None
    };
    let session_has_table = match &session_conn {
        Some(conn) => table_exists(conn, "session")?,
        None => false,
    };

    let mut items = Vec::with_capacity(snapshots.len());
    for snapshot in &snapshots {
        let exists_in_tasks = match (&tasks_conn, tasks_has_table) {
            (Some(conn), true) => {
                let found: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM tasks WHERE task_id = ?1 LIMIT 1",
                        [snapshot.task_id.as_str()],
                        |row| row.get(0),
                    )
                    .ok();
                found.is_some()
            }
            _ => false,
        };
        let exists_in_session = match (&session_conn, session_has_table) {
            (Some(conn), true) => {
                let found: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM session WHERE id = ?1 LIMIT 1",
                        [snapshot.task_id.as_str()],
                        |row| row.get(0),
                    )
                    .ok();
                found.is_some()
            }
            _ => false,
        };
        items.push(TransferPreviewItem {
            task_id: snapshot.task_id.clone(),
            title: snapshot.title(),
            workspace_path: snapshot
                .tasks_rows
                .first()
                .and_then(|row| row.get("workspace_path"))
                .and_then(Value::as_str)
                .map(str::to_string),
            updated_at: snapshot.updated_at(),
            message_count: snapshot.messages.len(),
            body_exists: snapshot.session_row.is_some(),
            exists_locally: exists_in_tasks || exists_in_session,
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(TransferPreviewPayload {
        format: manifest.format,
        version: manifest.version,
        exported_at: manifest.exported_at,
        total: items.len(),
        items,
    })
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/// 导入前备份单个库（VACUUM INTO 只读快照，不动源库）。返回是否备份了。
fn backup_database(source: &Path, backup_path: &Path) -> Result<bool, CoreError> {
    if !source.exists() {
        return Ok(false);
    }
    let conn = open_read_only(source)?;
    conn.execute_batch(&format!(
        "VACUUM INTO '{}'",
        backup_path.display().to_string().replace('\'', "''")
    ))?;
    Ok(true)
}

/// 通用整行插入：列取 zip 行与本地表列的交集，返回 INSERT 语句与列序。
fn build_insert(
    table: &str,
    local_cols: &[String],
    row: &JsonMap<String, Value>,
) -> Option<(String, Vec<String>)> {
    let cols: Vec<String> = local_cols
        .iter()
        .filter(|c| row.contains_key(c.as_str()))
        .cloned()
        .collect();
    if cols.is_empty() {
        return None;
    }
    let quoted: Vec<String> = cols.iter().map(|c| format!("\"{c}\"")).collect();
    let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        quoted.join(", "),
        placeholders.join(", ")
    );
    Some((sql, cols))
}

fn execute_insert(
    conn: &Connection,
    table: &str,
    local_cols: &[String],
    row: &JsonMap<String, Value>,
    ignore_conflicts: bool,
) -> Result<usize, CoreError> {
    let Some((sql, cols)) = build_insert(table, local_cols, row) else {
        return Err(CoreError::InvalidData(format!(
            "{table} 行与本地表结构无交集，无法导入"
        )));
    };
    let mut values = Vec::with_capacity(cols.len());
    for col in &cols {
        values.push(json_to_sql(row.get(col).unwrap_or(&Value::Null))?);
    }
    let sql = if ignore_conflicts {
        sql.replacen("INSERT INTO", "INSERT OR IGNORE INTO", 1)
    } else {
        sql
    };
    let changed = conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(changed)
}

/// 把会话包导入本地 ZCode。写库前自动备份两库到
/// `zmate/backups/session-transfer/<时间戳>/`。
pub fn import_sessions(
    paths: &ZCodePaths,
    zip_path: &Path,
    mode: ImportMode,
    progress: Option<ProgressFn>,
) -> Result<TransferImportPayload, CoreError> {
    let (_, snapshots) = parse_zip(zip_path)?;
    let total = snapshots.len();

    // 1) 备份（VACUUM INTO 快照，源库只读不动）。
    notify(progress, "backup", 0, 1);
    let backup_dir = paths
        .session_transfer_backups_dir
        .join(chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string());
    std::fs::create_dir_all(&backup_dir)?;
    backup_database(&paths.tasks_db_path, &backup_dir.join("tasks-index.sqlite"))?;
    backup_database(&paths.session_db_path, &backup_dir.join("db.sqlite"))?;
    notify(progress, "backup", 1, 1);

    // 2) 索引库：tasks 行整事务导入。
    std::fs::create_dir_all(
        paths
            .tasks_db_path
            .parent()
            .unwrap_or_else(|| Path::new("/")),
    )?;
    {
        let mut conn = Connection::open(&paths.tasks_db_path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        if !table_exists(&conn, "tasks")? {
            return Err(CoreError::InvalidData(
                "tasks-index.sqlite 缺少 tasks 表，无法导入会话索引".to_string(),
            ));
        }
        let tasks_cols = table_columns(&conn, "tasks")?;
        let tx = conn.transaction()?;
        for snapshot in &snapshots {
            for row in &snapshot.tasks_rows {
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM tasks WHERE task_id = ?1 LIMIT 1",
                        [snapshot.task_id.as_str()],
                        |_| Ok(()),
                    )
                    .is_ok();
                if exists && mode == ImportMode::Overwrite {
                    tx.execute("DELETE FROM tasks WHERE task_id = ?1", [
                        snapshot.task_id.as_str(),
                    ])?;
                }
                // 跳过模式遇到已存在行靠 OR IGNORE 兜底（同 workspace_key 主键不再重复插入）。
                execute_insert(&tx, "tasks", &tasks_cols, row, true)?;
            }
        }
        tx.commit()?;
    }

    // 3) 正文库：session/message/part/用量整事务导入（外键开启保证级联删除生效）。
    std::fs::create_dir_all(
        paths
            .session_db_path
            .parent()
            .unwrap_or_else(|| Path::new("/")),
    )?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    {
        let mut conn = Connection::open(&paths.session_db_path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        if !table_exists(&conn, "session")? {
            return Err(CoreError::InvalidData(
                "db.sqlite 缺少 session 表，无法导入会话正文".to_string(),
            ));
        }
        let schema_cols: HashMap<String, Vec<String>> = {
            let mut map = HashMap::new();
            map.insert("session".to_string(), table_columns(&conn, "session")?);
            if table_exists(&conn, "message")? {
                map.insert("message".to_string(), table_columns(&conn, "message")?);
            }
            if table_exists(&conn, "part")? {
                map.insert("part".to_string(), table_columns(&conn, "part")?);
            }
            for table in usage_tables(&conn)? {
                map.insert(table.clone(), table_columns(&conn, &table)?);
            }
            map
        };
        let has_message = schema_cols.contains_key("message");
        let has_part = schema_cols.contains_key("part");

        let tx = conn.transaction()?;
        for (idx, snapshot) in snapshots.iter().enumerate() {
            let mut wrote_any = false;

            if let Some(session_row) = &snapshot.session_row {
                let session_cols = schema_cols.get("session").unwrap();
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM session WHERE id = ?1 LIMIT 1",
                        [snapshot.task_id.as_str()],
                        |_| Ok(()),
                    )
                    .is_ok();

                if !(exists && mode == ImportMode::Skip) {
                    if mode == ImportMode::Overwrite {
                        // 覆盖：无条件清理本地同 id 残留再整行写入。行不存在时 DELETE 是
                        // 无害 no-op，同时兼顾「session 行已缺失但用量行残留」的孤儿情况
                        //（外键级联清 message/part，用量表不依赖级联再显式清一次）。
                        tx.execute("DELETE FROM session WHERE id = ?1", [
                            snapshot.task_id.as_str(),
                        ])?;
                        for table in usage_tables(&tx)? {
                            tx.execute(
                                &format!("DELETE FROM {table} WHERE session_id = ?1"),
                                [snapshot.task_id.as_str()],
                            )?;
                        }
                    }
                    execute_insert(&tx, "session", session_cols, session_row, false)?;
                    if has_message {
                        let message_cols = schema_cols.get("message").unwrap();
                        for (msg_row, part_rows) in &snapshot.messages {
                            execute_insert(&tx, "message", message_cols, msg_row, false)?;
                            if has_part {
                                let part_cols = schema_cols.get("part").unwrap();
                                for part_row in part_rows {
                                    // part 已随本会话整体重建，重复主键只可能是包内异常，忽略兜底。
                                    let _ = execute_insert(&tx, "part", part_cols, part_row, true);
                                }
                            }
                        }
                    }
                    for (table, rows) in &snapshot.usage {
                        if let Some(cols) = schema_cols.get(table) {
                            for row in rows {
                                let _ = execute_insert(&tx, table, cols, row, true);
                            }
                        }
                    }
                    wrote_any = true;
                }
            }

            if wrote_any {
                imported += 1;
            } else {
                skipped += 1;
            }
            notify(progress, "import", idx + 1, total);
        }
        tx.commit()?;
    }

    Ok(TransferImportPayload {
        imported,
        skipped,
        backup_dir: backup_dir.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 造一个假 ZCode home：两个会话（sess_a 2 消息 3 part + 用量；sess_b 1 消息 1 part）。
    fn setup_home(tag: &str) -> (PathBuf, ZCodePaths) {
        let root = std::env::temp_dir().join(format!(
            "zmate-transfer-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let paths = ZCodePaths::from_home(root.join(".zcode"));
        std::fs::create_dir_all(paths.tasks_db_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(paths.session_db_path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&paths.session_transfer_backups_dir).unwrap();

        let conn = Connection::open(&paths.tasks_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                workspace_key TEXT NOT NULL,
                task_id TEXT NOT NULL,
                title TEXT,
                task_status TEXT,
                provider TEXT,
                model TEXT,
                mode TEXT,
                pinned INTEGER DEFAULT 0,
                archived INTEGER DEFAULT 0,
                deleted INTEGER DEFAULT 0,
                created_at INTEGER,
                updated_at INTEGER,
                searchable_text TEXT,
                PRIMARY KEY (workspace_key, task_id)
            );
            INSERT INTO tasks (workspace_key, task_id, title, task_status, provider, model, mode, pinned, archived, deleted, created_at, updated_at, searchable_text) VALUES
                ('ws1', 'sess_a', '会话A', 'idle', 'prov1', 'model-a', NULL, 0, 0, 0, 1000, 2000, 'a'),
                ('ws1', 'sess_b', '会话B', 'idle', NULL, NULL, NULL, 0, 0, 0, 3000, 4000, 'b');",
        )
        .unwrap();

        let conn = Connection::open(&paths.session_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                directory TEXT,
                version TEXT
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                time_created INTEGER,
                sequence INTEGER,
                data TEXT
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
                time_created INTEGER,
                sequence INTEGER,
                data TEXT
            );
            CREATE TABLE model_usage (
                session_id TEXT,
                model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                reasoning_tokens INTEGER,
                cache_read_input_tokens INTEGER,
                duration_ms INTEGER,
                tool_call_count INTEGER,
                started_at INTEGER,
                completed_at INTEGER
            );
            INSERT INTO session (id, title, directory, version) VALUES
                ('sess_a', '会话A', '/tmp/a', '0.16.9'),
                ('sess_b', '会话B', '/tmp/b', '0.16.9');
            INSERT INTO message (id, session_id, time_created, sequence, data) VALUES
                ('msg_a1', 'sess_a', 10, 0, '{\"role\":\"user\"}'),
                ('msg_a2', 'sess_a', 20, 1, '{\"role\":\"assistant\"}'),
                ('msg_b1', 'sess_b', 30, 0, '{\"role\":\"user\"}');
            INSERT INTO part (id, message_id, time_created, sequence, data) VALUES
                ('p_a1_1', 'msg_a1', 11, 0, '{\"type\":\"text\"}'),
                ('p_a2_1', 'msg_a2', 21, 0, '{\"type\":\"text\"}'),
                ('p_a2_2', 'msg_a2', 22, 1, '{\"type\":\"tool\"}'),
                ('p_b1_1', 'msg_b1', 31, 0, '{\"type\":\"text\"}');
            INSERT INTO model_usage (session_id, model, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, duration_ms, tool_call_count, started_at, completed_at) VALUES
                ('sess_a', 'model-a', 100, 50, 10, 80, 900, 2, 1, 99);",
        )
        .unwrap();
        (root, paths)
    }

    fn count(conn_path: &Path, sql: &str) -> i64 {
        let conn = Connection::open_with_flags(conn_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn export_then_inspect_and_import_round_trip() {
        let (_root, paths) = setup_home("roundtrip");
        let zip_path = _root.join("out.zip");

        let result = export_sessions(&paths, &["sess_a".into(), "sess_b".into()], &zip_path, None)
            .unwrap();
        assert_eq!(result.exported, 2);
        assert!(result.missing_task_ids.is_empty());
        assert!(result.file_bytes > 0);
        assert!(zip_path.exists());

        // 预览：此时数据仍在本地（尚未删库），应全部标记为已存在、正文齐全。
        let preview = inspect_session_zip(&paths, &zip_path).unwrap();
        assert_eq!(preview.format, TRANSFER_FORMAT);
        assert_eq!(preview.total, 2);
        assert!(preview.items.iter().all(|i| i.exists_locally));
        let item_a = preview.items.iter().find(|i| i.task_id == "sess_a").unwrap();
        assert_eq!(item_a.message_count, 2);
        assert!(item_a.body_exists);
        assert_eq!(item_a.title, "会话A");

        // 删库重建空 schema，导入后行数与内容一致。
        std::fs::remove_file(&paths.tasks_db_path).unwrap();
        std::fs::remove_file(&paths.session_db_path).unwrap();
        let conn = Connection::open(&paths.tasks_db_path).unwrap();
        conn.execute_batch("CREATE TABLE tasks (workspace_key TEXT, task_id TEXT, title TEXT, updated_at INTEGER, PRIMARY KEY (workspace_key, task_id));").unwrap();
        let conn = Connection::open(&paths.session_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE, time_created INTEGER, data TEXT);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id) ON DELETE CASCADE, data TEXT);",
        )
        .unwrap();

        let import = import_sessions(&paths, &zip_path, ImportMode::Skip, None).unwrap();
        assert_eq!(import.imported, 2);
        assert_eq!(import.skipped, 0);
        assert_eq!(
            count(&paths.tasks_db_path, "SELECT COUNT(*) FROM tasks"),
            2
        );
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM session"),
            2
        );
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM message"),
            3
        );
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM part"),
            4
        );
        let title: String = Connection::open(&paths.tasks_db_path)
            .unwrap()
            .query_row("SELECT title FROM tasks WHERE task_id='sess_a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "会话A");
        // 备份目录已生成。
        assert!(paths.session_transfer_backups_dir.exists());
        let found = std::fs::read_dir(&paths.session_transfer_backups_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().join("db.sqlite").exists());
        assert!(found, "导入前应有 db.sqlite 备份");
    }

    #[test]
    fn import_skip_then_overwrite_conflicts() {
        let (_root, paths) = setup_home("conflict");
        let zip_path = _root.join("out.zip");
        export_sessions(&paths, &["sess_a".into(), "sess_b".into()], &zip_path, None).unwrap();

        // 同库重复导入：skip 全部跳过。
        let skipped = import_sessions(&paths, &zip_path, ImportMode::Skip, None).unwrap();
        assert_eq!(skipped.imported, 0);
        assert_eq!(skipped.skipped, 2);
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM message"),
            3,
            "skip 模式不应产生重复消息"
        );

        // 手工删掉 sess_a 的正文（CASCADE 应已验证可用），overwrite 导入应恢复。
        let conn = Connection::open(&paths.session_db_path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM session WHERE id='sess_a';")
            .unwrap();
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM message"),
            1
        );

        let restored = import_sessions(&paths, &zip_path, ImportMode::Overwrite, None).unwrap();
        assert_eq!(restored.imported, 2, "overwrite 应覆盖已存在的 sess_b 并找回 sess_a");
        assert_eq!(
            count(&paths.session_db_path, "SELECT COUNT(*) FROM message"),
            3
        );
        assert_eq!(
            count(
                &paths.session_db_path,
                "SELECT COUNT(*) FROM model_usage WHERE session_id='sess_a'"
            ),
            1
        );
    }

    #[test]
    fn inspect_reports_local_conflicts() {
        let (_root, paths) = setup_home("inspect");
        let zip_path = _root.join("out.zip");
        export_sessions(&paths, &["sess_a".into()], &zip_path, None).unwrap();
        let preview = inspect_session_zip(&paths, &zip_path).unwrap();
        assert_eq!(preview.total, 1);
        assert!(preview.items[0].exists_locally, "本地已有 sess_a 应标记冲突");
        assert_eq!(preview.items[0].title, "会话A");
    }

    #[test]
    fn invalid_zip_and_missing_tasks_error_out() {
        let (_root, paths) = setup_home("invalid");
        let bad = _root.join("bad.zip");
        std::fs::write(&bad, b"not a zip").unwrap();
        let err = inspect_session_zip(&paths, &bad).unwrap_err();
        assert!(matches!(err, CoreError::InvalidData(_)));

        // 合法 zip 但没有 manifest。
        let no_manifest = _root.join("no-manifest.zip");
        let file = std::fs::File::create(&no_manifest).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("other.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"hi").unwrap();
        writer.finish().unwrap();
        let err = inspect_session_zip(&paths, &no_manifest).unwrap_err();
        assert!(matches!(err, CoreError::InvalidData(_)));

        // 空 task_ids 直接报错。
        let out = _root.join("empty.zip");
        assert!(export_sessions(&paths, &[], &out, None).is_err());
    }
}
