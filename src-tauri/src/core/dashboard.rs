//! 仪表盘聚合：一次拉齐供应商 / 会话 / MCP / Skills 统计、数据健康状态
//! 与活跃趋势（按天聚合，全部只读）。

use crate::core::mcp;
use crate::core::models::{current_timestamp, CoreError, DiagnosePathCheck};
use crate::core::providers;
use crate::core::skills;
use crate::platform::paths::ZCodePaths;
use rusqlite::OpenFlags;
use serde::Serialize;
use chrono::{Datelike, TimeZone};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDay {
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyDay {
    pub date: String,
    /// 24 个小时桶（本地时间 0-23 时）的活跃消息数
    pub counts: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDay {
    pub date: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardPayload {
    pub provider_count: usize,
    pub model_count: usize,
    pub session_count: i64,
    pub session_storage_bytes: i64,
    pub mcp_total: i32,
    pub mcp_enabled: i32,
    pub skill_count: i32,
    pub skill_backup_count: i32,
    pub zcode_running: bool,
    pub zcode_home: String,
    pub core_version: String,
    pub path_checks: Vec<DiagnosePathCheck>,
    pub provider_config_valid: bool,
    pub provider_config_error: Option<String>,
    pub cli_config_valid: bool,
    pub cli_config_error: Option<String>,
    pub activity: Vec<ActivityDay>,
    pub hourly_activity: Vec<HourlyDay>,
    pub hourly_tokens: Vec<HourlyDay>,
    pub token_days: Vec<TokenDay>,
    pub generated_at: i64,
}

pub fn load_dashboard(paths: &ZCodePaths) -> Result<DashboardPayload, CoreError> {
    // --- 供应商 ---
    let (provider_count, model_count) = match providers::load_provider_state(paths) {
        Ok(state) => (state.items.len(), state.items.iter().map(|p| p.model_count).sum()),
        Err(_) => (0, 0),
    };

    // --- MCP ---
    let (mcp_total, mcp_enabled) = match mcp::load_mcp_servers(paths) {
        Ok(list) => (
            list.total,
            list.items.iter().filter(|s| s.enabled).count() as i32,
        ),
        Err(_) => (0, 0),
    };

    // --- Skills ---
    let (skill_count, skill_backup_count) = (
        skills::load_installed_skills(&paths.skills_dir)
            .map(|items| items.len() as i32)
            .unwrap_or(0),
        skills::load_skill_backups(&paths.skill_backups_dir)
            .map(|items| items.len() as i32)
            .unwrap_or(0),
    );

    // --- 会话统计 ---
    let (session_count, activity) = session_stats(paths);
    let hourly_activity = hourly_activity(paths);
    let hourly_tokens = hourly_tokens(paths);
    let session_storage_bytes = storage_bytes(paths);
    let token_days = load_token_days(paths);

    // --- 健康检查（与维护页 diagnose 同一套判定） ---
    let path = |p: &Path, key: &str| DiagnosePathCheck {
        key: key.to_string(),
        path: p.to_string_lossy().to_string(),
        exists: p.exists(),
    };
    let path_checks = vec![
        path(&paths.zcode_home, "zcodeHome"),
        path(&paths.provider_config_path, "providerConfig"),
        path(&paths.cli_config_path, "cliConfig"),
        path(&paths.skills_dir, "skillsDir"),
        path(&paths.agents_md_path, "agentsMd"),
        path(&paths.tasks_db_path, "tasksDb"),
        path(&paths.session_db_path, "sessionDb"),
    ];
    let (provider_config_valid, provider_config_error) = check_json_file(&paths.provider_config_path);
    let (cli_config_valid, cli_config_error) = check_json_file(&paths.cli_config_path);

    Ok(DashboardPayload {
        provider_count,
        model_count,
        session_count,
        session_storage_bytes,
        mcp_total,
        mcp_enabled,
        skill_count,
        skill_backup_count,
        zcode_running: crate::platform::process::is_zcode_running(),
        zcode_home: paths.zcode_home.to_string_lossy().to_string(),
        core_version: env!("CARGO_PKG_VERSION").to_string(),
        path_checks,
        provider_config_valid,
        provider_config_error,
        cli_config_valid,
        cli_config_error,
        activity,
        hourly_activity,
        hourly_tokens,
        token_days,
        generated_at: current_timestamp(),
    })
}

fn check_json_file(path: &Path) -> (bool, Option<String>) {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(_) => (true, None),
            Err(e) => (false, Some(format!("JSON 解析失败：{e}"))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (true, None),
        Err(e) => (false, Some(format!("读取失败：{e}"))),
    }
}

/// 会话总数 + 按天活跃度（以 updated_at 为准），库不存在时返回空。
fn session_stats(paths: &ZCodePaths) -> (i64, Vec<ActivityDay>) {
    if !paths.tasks_db_path.exists() {
        return (0, vec![]);
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &paths.tasks_db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return (0, vec![]);
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));

    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tasks'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if !table_exists {
        return (0, vec![]);
    }

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE deleted=0", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    let mut activity = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT date(updated_at/1000, 'unixepoch', 'localtime') d, COUNT(*) c FROM tasks WHERE deleted=0 AND updated_at IS NOT NULL GROUP BY d ORDER BY d")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(ActivityDay {
                date: row.get::<_, String>(0)?,
                count: row.get::<_, i64>(1)?,
            })
        }) {
            for row in rows.flatten() {
                activity.push(row);
            }
        }
    }
    (count, activity)
}

/// 最近 7 天按「本地日期 + 小时」的消息活跃数（供周视图小时热力图）
fn hourly_activity(paths: &ZCodePaths) -> Vec<HourlyDay> {
    if !paths.session_db_path.exists() {
        return vec![];
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &paths.session_db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return vec![];
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='message'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if !table_exists {
        return vec![];
    }

    // 本自然年 1 月 1 日至今（覆盖年视图 12 个月、本月视图整月），24 个小时桶先填 0
    let today = chrono::Local::now().date_naive();
    let year_start = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
    let span = (today - year_start).num_days() as usize + 1;
    let mut days: Vec<HourlyDay> = (0..span)
        .rev()
        .map(|i| HourlyDay {
            date: (today - chrono::Duration::days(i as i64))
                .format("%Y-%m-%d")
                .to_string(),
            counts: vec![0; 24],
        })
        .collect();
    let cutoff_ms: i64 = days
        .first()
        .map(|d| {
            chrono::NaiveDate::parse_from_str(&d.date, "%Y-%m-%d")
                .map(|nd| {
                    chrono::Local
                        .from_local_datetime(&nd.and_hms_opt(0, 0, 0).unwrap())
                        .single()
                        .map(|dt| dt.with_timezone(&chrono::Utc).timestamp_millis())
                        .unwrap_or(0)
                })
                .unwrap_or(0)
        })
        .unwrap_or(0);

    let Ok(mut stmt) = conn.prepare(
        "SELECT date(time_created/1000, 'unixepoch', 'localtime') d, \
                CAST(strftime('%H', time_created/1000, 'unixepoch', 'localtime') AS INTEGER) h, \
                COUNT(*) c \
         FROM message \
         WHERE time_created IS NOT NULL AND time_created >= ?1 \
         GROUP BY d, h",
    ) else {
        return vec![];
    };
    if let Ok(rows) = stmt.query_map([cutoff_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        for row in rows.flatten() {
            let (d, h, c) = row;
            if let Some(day) = days.iter_mut().find(|day| day.date == d) {
                if (0..24).contains(&h) {
                    day.counts[h as usize] += c;
                }
            }
        }
    }
    days
}

/// Token 按天聚合（model_usage.started_at 为 epoch 毫秒），库/表缺失时为空。
fn load_token_days(paths: &ZCodePaths) -> Vec<TokenDay> {
    if !paths.session_db_path.exists() {
        return vec![];
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &paths.session_db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return vec![];
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));

    let mut days = Vec::new();
    let sql = "SELECT date(started_at/1000, 'unixepoch', 'localtime') d, \
               COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), \
               COALESCE(SUM(reasoning_tokens),0), COALESCE(SUM(input_tokens)+SUM(output_tokens)+SUM(reasoning_tokens),0) \
               FROM model_usage WHERE started_at IS NOT NULL GROUP BY d ORDER BY d";
    if let Ok(mut stmt) = conn.prepare(sql) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(TokenDay {
                date: row.get::<_, String>(0)?,
                input_tokens: row.get::<_, i64>(1)?,
                output_tokens: row.get::<_, i64>(2)?,
                reasoning_tokens: row.get::<_, i64>(3)?,
                total_tokens: row.get::<_, i64>(4)?,
            })
        }) {
            for row in rows.flatten() {
                days.push(row);
            }
        }
    }
    days
}

/// 与 hourly_activity 同窗口，按「本地日期 + 小时」聚合 model_usage 的 token 总量（供周/月/年 Token 视图）
fn hourly_tokens(paths: &ZCodePaths) -> Vec<HourlyDay> {
    if !paths.session_db_path.exists() {
        return vec![];
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &paths.session_db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return vec![];
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='model_usage'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if !table_exists {
        return vec![];
    }

    let today = chrono::Local::now().date_naive();
    let year_start = chrono::NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
    let span = (today - year_start).num_days() as usize + 1;
    let mut days: Vec<HourlyDay> = (0..span)
        .rev()
        .map(|i| HourlyDay {
            date: (today - chrono::Duration::days(i as i64))
                .format("%Y-%m-%d")
                .to_string(),
            counts: vec![0; 24],
        })
        .collect();
    let cutoff_ms: i64 = days
        .first()
        .map(|d| {
            chrono::NaiveDate::parse_from_str(&d.date, "%Y-%m-%d")
                .map(|nd| {
                    chrono::Local
                        .from_local_datetime(&nd.and_hms_opt(0, 0, 0).unwrap())
                        .single()
                        .map(|dt| dt.with_timezone(&chrono::Utc).timestamp_millis())
                        .unwrap_or(0)
                })
                .unwrap_or(0)
        })
        .unwrap_or(0);

    let Ok(mut stmt) = conn.prepare(
        "SELECT date(started_at/1000, 'unixepoch', 'localtime') d, \
                CAST(strftime('%H', started_at/1000, 'unixepoch', 'localtime') AS INTEGER) h, \
                COALESCE(SUM(input_tokens)+SUM(output_tokens)+SUM(reasoning_tokens),0) t \
         FROM model_usage \
         WHERE started_at IS NOT NULL AND started_at >= ?1 \
         GROUP BY d, h",
    ) else {
        return vec![];
    };
    if let Ok(rows) = stmt.query_map([cutoff_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        for row in rows.flatten() {
            let (d, h, t) = row;
            if let Some(day) = days.iter_mut().find(|day| day.date == d) {
                if (0..24).contains(&h) {
                    day.counts[h as usize] += t;
                }
            }
        }
    }
    days
}

/// 会话相关存储体积（两个 sqlite 库 + rollout 日志），仪表盘与会话页共用。
pub fn storage_bytes(paths: &ZCodePaths) -> i64 {    let file_size = |p: &Path| std::fs::metadata(p).map(|m| m.len() as i64).unwrap_or(0);
    let mut total = 0i64;
    for base in [&paths.tasks_db_path, &paths.session_db_path] {
        total += file_size(base);
        total += file_size(&base.with_extension("sqlite-wal"));
        total += file_size(&base.with_extension("sqlite-shm"));
    }
    total += dir_size(&paths.rollout_dir);
    total
}

fn dir_size(dir: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0i64;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size(&p);
        } else {
            total += std::fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0);
        }
    }
    total
}
