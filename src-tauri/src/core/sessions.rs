//! 会话/任务只读访问层。
//!
//! 数据来源（一律只读打开，绝不写入 ZCode 的两个库）：
//! - `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表：会话列表索引
//! - `~/.zcode/cli/db/db.sqlite` 的 `session` / `message` / `part` / `model_usage` 表：会话正文与用量统计
//!
//! 已在本机 ZCode 0.16.9 实测核实的 JSON 键名（`part.data` / `message.data`）：
//! - `message.data`：`$.role`（"user" / "assistant"）、`$.time.created`
//! - `part.data`：
//!   - `{"type":"text","text":"..."}`                                        → 正文在 `$.text`
//!   - `{"type":"reasoning","text":"..."}`                                   → 正文在 `$.text`
//!   - `{"type":"tool","tool":"Bash","state":{"input":{...},"output":"..."}}` → 工具名 `$.tool`、状态 `$.state`
//!   - 其他类型：step-start / step-finish / timeline / file / compaction
//!
//! 注意：所有 SQL 均先通过 `PRAGMA table_info` 探测列是否存在，缺失列用
//! `NULL` / `0` 占位拼进 SQL，保证旧版本库（缺列/缺表）也能容错执行。

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::core::models::{current_timestamp, CoreError};
use crate::platform::paths::ZCodePaths;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 会话详情最多返回的 part 总数（超过则置 truncated 并停止追加）。
const MAX_PART_COUNT: usize = 500;
/// 会话详情所有 part 文本的总字节上限（2MB）。
const MAX_TOTAL_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// 工具类 / 其他类 part 摘要 JSON 的截断长度（字符数）。
const SUMMARY_JSON_LIMIT: usize = 200;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 会话列表条目（来自 tasks-index.sqlite 的 tasks 表）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub task_id: String,
    pub workspace_path: String,
    pub title: String,
    pub status: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 会话列表载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListPayload {
    pub items: Vec<SessionSummary>,
    pub total: i64,
    pub source_path: String,
    pub db_exists: bool,
    pub last_scan_at: i64,
}

/// 消息内单个 part 的渲染结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessagePart {
    /// "text" | "reasoning" | "tool" | "other"
    pub kind: String,
    pub text: String,
}

/// 单条消息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    pub role: String,
    pub time_created: i64,
    pub parts: Vec<SessionMessagePart>,
}

/// 会话详情载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailPayload {
    pub task_id: String,
    pub title: String,
    pub directory: Option<String>,
    pub version: Option<String>,
    pub messages: Vec<SessionMessage>,
    pub truncated: bool,
}

/// 会话用量统计（model_usage 表按 session_id 汇总）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsPayload {
    pub task_id: String,
    pub request_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub total_duration_ms: i64,
    pub tool_call_count: i64,
    pub first_request_at: Option<i64>,
    pub last_request_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 以只读模式打开 SQLite，并设置 2 秒 busy 超时（绝不写库）。
fn open_read_only(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_secs(2))?;
    Ok(conn)
}

/// 读取某张表实际存在的列名集合（PRAGMA table_info）；表不存在时返回空列表。
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, CoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut cols = Vec::new();
    for row in rows {
        cols.push(row?);
    }
    Ok(cols)
}

/// 判断某张表是否存在。
fn table_exists(conn: &Connection, table: &str) -> Result<bool, CoreError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 列存在则返回列名本身，否则返回 `NULL AS 列名`，保证 SELECT 始终可执行。
fn col_or_null(columns: &[String], name: &str) -> String {
    if columns.iter().any(|c| c == name) {
        name.to_string()
    } else {
        format!("NULL AS {}", name)
    }
}

/// 按字符数截断字符串（UTF-8 安全，不会切在多字节字符中间）。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    // 字节数都不超上限时字符数必然不超（UTF-8 每字符至少 1 字节），快速返回。
    if text.len() <= max_chars {
        return text.to_string();
    }
    match text.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => text[..byte_idx].to_string(),
        // 实际字符数少于 max_chars（多字节字符居多），原样返回。
        None => text.to_string(),
    }
}

/// 把单个 part 的 data JSON 渲染为 (kind, text)。
///
/// 键名以实测为准：text/reasoning 正文在 `$.text`；工具名在 `$.tool`、
/// 状态在 `$.state`；解析失败或未知类型一律按 "other" 处理并截断原始 JSON。
fn render_part(data_str: &str) -> (String, String) {
    let value: serde_json::Value = match serde_json::from_str(data_str) {
        Ok(v) => v,
        // data 不是合法 JSON：按 other 兜底，截断原始文本。
        Err(_) => return ("other".to_string(), truncate_chars(data_str, SUMMARY_JSON_LIMIT)),
    };
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "text" => (
            "text".to_string(),
            value
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        "reasoning" => (
            "reasoning".to_string(),
            value
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        "tool" => {
            let tool_name = value.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            // state JSON 摘要（截断 200 字符）；state 缺失时退回整个 data。
            let state_json = match value.get("state") {
                Some(state) => serde_json::to_string(state).unwrap_or_default(),
                None => serde_json::to_string(&value).unwrap_or_default(),
            };
            (
                "tool".to_string(),
                format!(
                    "{} {}",
                    tool_name,
                    truncate_chars(&state_json, SUMMARY_JSON_LIMIT)
                ),
            )
        }
        _ => (
            "other".to_string(),
            truncate_chars(
                &serde_json::to_string(&value).unwrap_or_default(),
                SUMMARY_JSON_LIMIT,
            ),
        ),
    }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/// 会话页顶部统计卡：总数 / 存储体积 / 活跃天数 / 日均会话（全部只读）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOverviewPayload {
    pub total_sessions: i64,
    pub storage_bytes: i64,
    pub active_days: i64,
    pub avg_per_active_day: f64,
}

pub fn get_session_overview(paths: &ZCodePaths) -> Result<SessionOverviewPayload, CoreError> {
    let mut total_sessions = 0i64;
    let mut active_days = 0i64;

    if paths.tasks_db_path.exists() {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &paths.tasks_db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
            let table_exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tasks'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if table_exists {
                total_sessions = conn
                    .query_row("SELECT COUNT(*) FROM tasks WHERE deleted=0", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0);
                active_days = conn
                    .query_row(
                        "SELECT COUNT(DISTINCT date(updated_at/1000, 'unixepoch', 'localtime')) \
                         FROM tasks WHERE deleted=0 AND updated_at IS NOT NULL",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
            }
        }
    }

    let avg_per_active_day = if active_days > 0 {
        (total_sessions as f64 / active_days as f64 * 10.0).round() / 10.0
    } else {
        0.0
    };

    Ok(SessionOverviewPayload {
        total_sessions,
        storage_bytes: crate::core::dashboard::storage_bytes(paths),
        active_days,
        avg_per_active_day,
    })
}

/// 列出会话（tasks 表，按 updated_at 倒序，分页 + 可选搜索/归档过滤）。
///
/// 数据库文件不存在时返回 `db_exists = false` 的空载荷（不是错误）。
pub fn list_sessions(
    paths: &ZCodePaths,
    query: Option<&str>,
    include_archived: bool,
    limit: i64,
    offset: i64,
) -> Result<SessionListPayload, CoreError> {
    let source_path = paths.tasks_db_path.display().to_string();
    let empty_payload = |db_exists: bool| SessionListPayload {
        items: Vec::new(),
        total: 0,
        source_path: source_path.clone(),
        db_exists,
        last_scan_at: current_timestamp(),
    };

    if !paths.tasks_db_path.exists() {
        return Ok(empty_payload(false));
    }
    let conn = open_read_only(&paths.tasks_db_path)?;
    if !table_exists(&conn, "tasks")? {
        // 库文件存在但 tasks 表缺失（异常状态），按空结果容错。
        return Ok(empty_payload(true));
    }
    let cols = table_columns(&conn, "tasks")?;

    // 动态拼 SELECT：缺失的列用 NULL 占位，保持列序稳定。
    let select_sql = format!(
        "SELECT {} AS workspace_path, {} AS task_id, {} AS title, {} AS task_status, \
         {} AS provider, {} AS model, {} AS mode, {} AS pinned, {} AS archived, \
         {} AS created_at, {} AS updated_at FROM tasks",
        col_or_null(&cols, "workspace_path"),
        col_or_null(&cols, "task_id"),
        col_or_null(&cols, "title"),
        col_or_null(&cols, "task_status"),
        col_or_null(&cols, "provider"),
        col_or_null(&cols, "model"),
        col_or_null(&cols, "mode"),
        col_or_null(&cols, "pinned"),
        col_or_null(&cols, "archived"),
        col_or_null(&cols, "created_at"),
        col_or_null(&cols, "updated_at"),
    );

    // 动态拼 WHERE：deleted=0 固定过滤；archived 按需；搜索匹配 title / searchable_text。
    let mut conditions: Vec<String> = Vec::new();
    if cols.iter().any(|c| c == "deleted") {
        conditions.push("deleted = 0".to_string());
    }
    if !include_archived && cols.iter().any(|c| c == "archived") {
        conditions.push("archived = 0".to_string());
    }
    let trimmed_query = query.map(str::trim).filter(|q| !q.is_empty());
    let has_query = trimmed_query.is_some();
    if has_query {
        if cols.iter().any(|c| c == "searchable_text") {
            conditions.push("(title LIKE ?1 OR searchable_text LIKE ?1)".to_string());
        } else {
            conditions.push("title LIKE ?1".to_string());
        }
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let like_param = trimmed_query
        .map(|q| format!("%{}%", q))
        .unwrap_or_default();

    // 总数（与列表同一筛选条件）。
    let count_sql = format!("SELECT COUNT(*) FROM tasks{}", where_clause);
    let total: i64 = if has_query {
        conn.query_row(&count_sql, [&like_param], |row| row.get(0))?
    } else {
        conn.query_row(&count_sql, [], |row| row.get(0))?
    };

    // 排序列容错：updated_at 缺失时退回 created_at，再缺失退回 rowid。
    let order_clause = if cols.iter().any(|c| c == "updated_at") {
        "updated_at DESC".to_string()
    } else if cols.iter().any(|c| c == "created_at") {
        "created_at DESC".to_string()
    } else {
        "rowid".to_string()
    };
    let page_sql = format!(
        "{}{} ORDER BY {} LIMIT ?{} OFFSET ?{}",
        select_sql,
        where_clause,
        order_clause,
        if has_query { 2 } else { 1 },
        if has_query { 3 } else { 2 },
    );

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SessionSummary> {
        Ok(SessionSummary {
            workspace_path: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            task_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            status: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            provider: row.get::<_, Option<String>>(4)?,
            model: row.get::<_, Option<String>>(5)?,
            mode: row.get::<_, Option<String>>(6)?,
            // pinned / archived / deleted 为 INTEGER，非 0 即真。
            pinned: row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
            archived: row.get::<_, Option<i64>>(8)?.unwrap_or(0) != 0,
            created_at: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
            updated_at: row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        })
    };

    let mut stmt = conn.prepare(&page_sql)?;
    let mut items = Vec::new();
    let rows = if has_query {
        stmt.query_map(rusqlite::params![like_param, limit, offset], map_row)?
    } else {
        stmt.query_map(rusqlite::params![limit, offset], map_row)?
    };
    for row in rows {
        items.push(row?);
    }

    Ok(SessionListPayload {
        items,
        total,
        source_path,
        db_exists: true,
        last_scan_at: current_timestamp(),
    })
}

/// 读取单个会话的正文详情（session / message / part 三表联读）。
///
/// 数据库文件或会话记录不存在时返回 `CoreError::NotFound`。
/// part 总数超 500 或正文总量超 2MB 时置 `truncated = true` 并停止追加。
pub fn get_session_detail(
    paths: &ZCodePaths,
    task_id: &str,
    text_limit: usize,
) -> Result<SessionDetailPayload, CoreError> {
    if !paths.session_db_path.exists() {
        return Err(CoreError::NotFound(format!(
            "session 数据库不存在: {}",
            paths.session_db_path.display()
        )));
    }
    let conn = open_read_only(&paths.session_db_path)?;

    if !table_exists(&conn, "session")? {
        return Err(CoreError::NotFound(format!(
            "session 表不存在（数据库: {}）",
            paths.session_db_path.display()
        )));
    }
    let session_cols = table_columns(&conn, "session")?;

    // 会话基本信息（session.id 即 task_id，如 sess_xxx）。
    let session_sql = format!(
        "SELECT {} AS title, {} AS directory, {} AS version FROM session WHERE id = ?1",
        col_or_null(&session_cols, "title"),
        col_or_null(&session_cols, "directory"),
        col_or_null(&session_cols, "version"),
    );
    let session_result = conn.query_row(&session_sql, [task_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    });
    let (title, directory, version) = match session_result {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(CoreError::NotFound(format!("会话不存在: {}", task_id)));
        }
        Err(e) => return Err(e.into()),
    };

    // message / part 表可能缺失（异常库），容错为空正文。
    let has_messages = table_exists(&conn, "message")?;
    let has_parts = table_exists(&conn, "part")?;
    let message_cols = if has_messages {
        table_columns(&conn, "message")?
    } else {
        Vec::new()
    };
    let part_cols = if has_parts {
        table_columns(&conn, "part")?
    } else {
        Vec::new()
    };

    // 排序容错：sequence 列存在则参与排序（可能为 NULL，用 COALESCE 归位）。
    let message_order = if message_cols.iter().any(|c| c == "sequence") {
        "time_created, COALESCE(sequence, -1), id"
    } else {
        "time_created, id"
    };
    let message_sql = format!(
        "SELECT id, time_created, data FROM message WHERE session_id = ?1 ORDER BY {}",
        message_order
    );
    let part_order = if part_cols.iter().any(|c| c == "sequence") {
        "COALESCE(sequence, -1), time_created, id"
    } else {
        "time_created, id"
    };
    let part_sql = format!(
        "SELECT data FROM part WHERE message_id = ?1 ORDER BY {}",
        part_order
    );
    let mut part_stmt = if has_parts {
        Some(conn.prepare(&part_sql)?)
    } else {
        None
    };

    // 逐条消息读取，逐 part 渲染；总量超限时置 truncated 并停止追加。
    let mut messages: Vec<SessionMessage> = Vec::new();
    let mut truncated = false;
    let mut total_text_bytes: usize = 0;
    let mut part_count: usize = 0;

    if has_messages {
        let mut msg_stmt = conn.prepare(&message_sql)?;
        let mut msg_rows = msg_stmt.query([task_id])?;
        while let Some(row) = msg_rows.next()? {
            let message_id: String = row.get(0)?;
            let time_created: i64 = row.get(1)?;
            let data_str: String = row.get(2)?;
            // role 从 data 的 $.role 提取；解析失败按空串处理，前端兜底。
            let role = serde_json::from_str::<serde_json::Value>(&data_str)
                .ok()
                .and_then(|v| {
                    v.get("role")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();

            let mut parts: Vec<SessionMessagePart> = Vec::new();
            if let Some(stmt) = part_stmt.as_mut() {
                let mut part_rows = stmt.query([&message_id])?;
                while let Some(prow) = part_rows.next()? {
                    part_count += 1;
                    if part_count > MAX_PART_COUNT || total_text_bytes >= MAX_TOTAL_TEXT_BYTES {
                        truncated = true;
                        break;
                    }
                    let pdata: String = prow.get(0)?;
                    let (kind, raw_text) = render_part(&pdata);
                    let text = truncate_chars(&raw_text, text_limit);
                    total_text_bytes += text.len();
                    parts.push(SessionMessagePart { kind, text });
                }
            }

            messages.push(SessionMessage {
                id: message_id,
                role,
                time_created,
                parts,
            });
            if truncated {
                break;
            }
        }
    }

    Ok(SessionDetailPayload {
        task_id: task_id.to_string(),
        title,
        directory,
        version,
        messages,
        truncated,
    })
}

/// 汇总单个会话的模型用量统计（model_usage 表，按 session_id 聚合）。
///
/// 数据库文件不存在时返回 `CoreError::NotFound`；model_usage 表缺失（旧版本
/// 库）时返回全 0 的统计，不视为错误。
pub fn get_session_stats(
    paths: &ZCodePaths,
    task_id: &str,
) -> Result<SessionStatsPayload, CoreError> {
    if !paths.session_db_path.exists() {
        return Err(CoreError::NotFound(format!(
            "session 数据库不存在: {}",
            paths.session_db_path.display()
        )));
    }
    let conn = open_read_only(&paths.session_db_path)?;

    if !table_exists(&conn, "model_usage")? {
        return Ok(SessionStatsPayload {
            task_id: task_id.to_string(),
            request_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            cache_read_tokens: 0,
            total_duration_ms: 0,
            tool_call_count: 0,
            first_request_at: None,
            last_request_at: None,
        });
    }
    let cols = table_columns(&conn, "model_usage")?;

    // 缺失的列用 0 / NULL 占位，保证聚合 SQL 始终可执行。
    let sum_col = |name: &str| -> String {
        if cols.iter().any(|c| c == name) {
            format!("SUM({})", name)
        } else {
            "0".to_string()
        }
    };
    let extremum_col = |agg: &str, name: &str| -> String {
        if cols.iter().any(|c| c == name) {
            format!("{}({})", agg, name)
        } else {
            "NULL".to_string()
        }
    };

    let stats_sql = format!(
        "SELECT COUNT(*), {}, {}, {}, {}, {}, {}, {}, {} \
         FROM model_usage WHERE session_id = ?1",
        sum_col("input_tokens"),
        sum_col("output_tokens"),
        sum_col("reasoning_tokens"),
        sum_col("cache_read_input_tokens"),
        sum_col("duration_ms"),
        sum_col("tool_call_count"),
        extremum_col("MIN", "started_at"),
        extremum_col("MAX", "completed_at"),
    );

    let stats_result = conn.query_row(&stats_sql, [task_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            // SUM 在无匹配行时为 NULL，统一落到 0。
            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<i64>>(8)?,
        ))
    });
    let (
        request_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        total_duration_ms,
        tool_call_count,
        first_request_at,
        last_request_at,
    ) = match stats_result {
        Ok(value) => value,
        // COUNT(*) 聚合理论上恒有一行，这里纯防御。
        Err(rusqlite::Error::QueryReturnedNoRows) => (0, 0, 0, 0, 0, 0, 0, None, None),
        Err(e) => return Err(e.into()),
    };

    Ok(SessionStatsPayload {
        task_id: task_id.to_string(),
        request_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        total_duration_ms,
        tool_call_count,
        first_request_at,
        last_request_at,
    })
}
