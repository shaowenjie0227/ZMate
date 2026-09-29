use crate::core::models::{
    CoreEnvelope, SiteConnectionStatusPayload, SiteVerifyPayload,
};
use crate::core::newapi::{
    self, KeysPayload, NewApiCreateTokenInput, NewApiGroupInfo, NewApiLogsPayload,
    NewApiRedeemResult, NewApiSiteInfo, NewApiTokenDetail, NewApiTokenInfo, NewApiUserProfile,
    SiteUsagePayload, WalletPayload,
};
use crate::core::settings;
use crate::platform::paths::ZCodePaths;
use std::sync::Arc;
use tauri::State;

/// 站点连接信息只在向导连接成功后落盘（settings.json，仅本机）
#[tauri::command]
pub fn newapi_save_site_connection(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: String,
    access_token: String,
    user_id: Option<i64>,
) -> Result<CoreEnvelope<bool>, String> {
    let mut app = settings::load_settings(&paths);
    app.site_base_url = base_url.trim().trim_end_matches('/').to_string();
    app.site_access_token = access_token.trim().to_string();
    app.site_user_id = user_id.unwrap_or(0);
    app.site_auth_method = "token".into();
    settings::save_settings(&paths, &app).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(true))
}

#[tauri::command]
pub fn newapi_clear_site_connection(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<bool>, String> {
    let mut app = settings::load_settings(&paths);
    app.site_base_url = String::new();
    app.site_access_token = String::new();
    app.site_user_id = 0;
    app.site_auth_method = String::new();
    settings::save_settings(&paths, &app).map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(true))
}

/// 登录令牌页：连接状态（不联网）；访问令牌绝不回传前端
#[tauri::command]
pub fn newapi_site_connection_status(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SiteConnectionStatusPayload>, String> {
    let app = settings::load_settings(&paths);
    let connected = !app.site_base_url.is_empty() && !app.site_access_token.is_empty();
    Ok(CoreEnvelope::ok(SiteConnectionStatusPayload {
        connected,
        base_url: app.site_base_url.clone(),
        auth_method: app.site_auth_method,
    }))
}

/// 个人中心：当前登录账号资料（用已存储的站点连接）
#[tauri::command]
pub async fn newapi_user_profile(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<NewApiUserProfile>, String> {
    let paths = paths.inner().clone();
    let profile = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id) = resolve_stored_connection(&paths)?;
        newapi::user_profile(
            &base_url,
            &access_token,
            opt_user_id(user_id),
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(profile))
}

/// 登录令牌页：用已存储的连接真实请求一次 /api/status 与 /api/user/self
#[tauri::command]
pub async fn newapi_verify_site_connection(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SiteVerifyPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(
        move || -> Result<SiteVerifyPayload, String> {
            let app = settings::load_settings(&paths);
            if app.site_base_url.is_empty() || app.site_access_token.is_empty() {
                return Ok(SiteVerifyPayload {
                    ok: false,
                    system_name: String::new(),
                    username: String::new(),
                    message: "尚未连接站点".into(),
                });
            }
            match newapi::probe_site(
                &app.site_base_url,
                &app.site_access_token,
                opt_user_id(app.site_user_id),
                std::time::Duration::from_secs(15),
            ) {
                Ok(info) => Ok(SiteVerifyPayload {
                    ok: true,
                    system_name: info.system_name,
                    username: info.username,
                    message: String::new(),
                }),
                Err(e) => Ok(SiteVerifyPayload {
                    ok: false,
                    system_name: String::new(),
                    username: String::new(),
                    message: e.to_string(),
                }),
            }
        },
    )
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(payload))
}

/// 登录令牌页：账号密码登录——站点会话换取系统访问令牌，验证通过后直接落盘（令牌不回传前端）
#[tauri::command]
pub async fn newapi_login_with_password(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: String,
    username: String,
    password: String,
) -> Result<CoreEnvelope<NewApiSiteInfo>, String> {
    let paths = paths.inner().clone();
    let info = tauri::async_runtime::spawn_blocking(
        move || -> Result<NewApiSiteInfo, crate::core::models::CoreError> {
            let base = base_url.trim().trim_end_matches('/').to_string();
            let (access_token, login_user_id) = newapi::login_with_password(
                &base,
                &username,
                &password,
                std::time::Duration::from_secs(15),
            )?;
            // 用新令牌真实请求一次，确认可用后再落盘
            let info = newapi::probe_site(
                &base,
                &access_token,
                opt_user_id(login_user_id),
                std::time::Duration::from_secs(15),
            )?;
            let mut app = settings::load_settings(&paths);
            app.site_base_url = base;
            app.site_access_token = access_token;
            app.site_user_id = if info.user_id > 0 { info.user_id } else { login_user_id };
            app.site_auth_method = "password".into();
            settings::save_settings(&paths, &app)?;
            Ok(info)
        },
    )
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(info))
}

/// site_user_id 传给需要 New-Api-User 头的站点版本；0 表示未知
fn opt_user_id(id: i64) -> Option<i64> {
    if id > 0 {
        Some(id)
    } else {
        None
    }
}

/// 读取已存储的站点连接；未连接时报错
fn resolve_stored_connection(
    paths: &ZCodePaths,
) -> Result<(String, String, i64), crate::core::models::CoreError> {
    use crate::core::models::CoreError;
    let app = settings::load_settings(paths);
    if !app.site_base_url.is_empty() && !app.site_access_token.is_empty() {
        return Ok((app.site_base_url, app.site_access_token, app.site_user_id));
    }
    Err(CoreError::OperationFailed(
        "尚未连接站点：请先在「登录令牌」页完成连接".into(),
    ))
}

/// 显式传入的连接优先，否则回落到已存储的站点连接。
/// 返回 (base, token, 存储的用户 ID, 是否走了存储连接)——显式连接不带存储的
/// 用户 ID，避免把 A 站的 ID 误传给 B 站。
fn resolve_site_connection(
    paths: &ZCodePaths,
    base_url: Option<String>,
    access_token: Option<String>,
) -> Result<(String, String, i64, bool), crate::core::models::CoreError> {
    use crate::core::models::CoreError;
    let explicit_base = base_url.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let explicit_token = access_token
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let (Some(base), Some(token)) = (explicit_base, explicit_token) {
        return Ok((base, token, 0, false));
    }
    let app = settings::load_settings(paths);
    if !app.site_base_url.is_empty() && !app.site_access_token.is_empty() {
        return Ok((app.site_base_url, app.site_access_token, app.site_user_id, true));
    }
    Err(CoreError::OperationFailed(
        "尚未连接站点：请先在「登录令牌」页完成连接".into(),
    ))
}

/// 仪表盘用量：未接入返回 connected=false；站点请求失败整体报错由前端展示
#[tauri::command]
pub async fn newapi_site_usage(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<SiteUsagePayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(
        move || -> Result<SiteUsagePayload, String> {
            let app = settings::load_settings(&paths);
            if app.site_base_url.is_empty() || app.site_access_token.is_empty() {
                return Ok(SiteUsagePayload {
                    connected: false,
                    base_url: String::new(),
                    summary: None,
                });
            }
            let summary = newapi::usage_summary(
                &app.site_base_url,
                &app.site_access_token,
                opt_user_id(app.site_user_id),
                std::time::Duration::from_secs(20),
            )
            .map_err(|e| e.to_string())?;
            Ok(SiteUsagePayload {
                connected: true,
                base_url: app.site_base_url.clone(),
                summary: Some(summary),
            })
        },
    )
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(payload))
}

/// 钱包统计：未接入返回 connected=false
#[tauri::command]
pub async fn newapi_wallet(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<WalletPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || -> Result<WalletPayload, String> {
        let app = settings::load_settings(&paths);
        if app.site_base_url.is_empty() || app.site_access_token.is_empty() {
            return Ok(WalletPayload {
                connected: false,
                stats: None,
            });
        }
        let stats = newapi::wallet_stats(
            &app.site_base_url,
            &app.site_access_token,
            opt_user_id(app.site_user_id),
            std::time::Duration::from_secs(15),
        )
        .map_err(|e| e.to_string())?;
        Ok(WalletPayload {
            connected: true,
            stats: Some(stats),
        })
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(payload))
}

/// 兑换码兑换；未接入时报错，兑换成功返回到账额度与最新余额
#[tauri::command]
pub async fn newapi_redeem(
    paths: State<'_, Arc<ZCodePaths>>,
    code: String,
) -> Result<CoreEnvelope<NewApiRedeemResult>, String> {
    let paths = paths.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<NewApiRedeemResult, String> {
            let app = settings::load_settings(&paths);
            if app.site_base_url.is_empty() || app.site_access_token.is_empty() {
                return Err("尚未接入站点，请先在供应商页完成站点接入".into());
            }
            newapi::redeem_code(
                &app.site_base_url,
                &app.site_access_token,
                opt_user_id(app.site_user_id),
                &code,
                std::time::Duration::from_secs(15),
            )
            .map_err(|e| e.to_string())
        },
    )
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(result))
}

#[tauri::command]
pub async fn newapi_probe_site(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    user_id: Option<i64>,
) -> Result<CoreEnvelope<NewApiSiteInfo>, String> {
    let paths = paths.inner().clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, stored_user_id, used_stored) =
            resolve_site_connection(&paths, base_url, access_token)?;
        // 显式填写的用户 ID 优先；存储连接才回落存储 ID
        let user_id = match user_id.filter(|id| *id > 0) {
            Some(id) => Some(id),
            None if used_stored => opt_user_id(stored_user_id),
            _ => None,
        };
        newapi::probe_site(&base_url, &access_token, user_id, std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(info))
}

#[tauri::command]
pub async fn newapi_list_tokens(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
) -> Result<CoreEnvelope<Vec<NewApiTokenInfo>>, String> {
    let paths = paths.inner().clone();
    let items = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::list_tokens(&base_url, &access_token, opt_user_id(user_id), std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(items))
}

#[tauri::command]
pub async fn newapi_reveal_token_key(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    token_id: i64,
) -> Result<CoreEnvelope<String>, String> {
    let paths = paths.inner().clone();
    let key = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::reveal_token_key(
            &base_url,
            &access_token,
            opt_user_id(user_id),
            token_id,
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(key))
}

#[tauri::command]
pub async fn newapi_affiliate_info(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
) -> Result<CoreEnvelope<newapi::NewApiAffiliateInfo>, String> {
    let paths = paths.inner().clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::affiliate_info(&base_url, &access_token, opt_user_id(user_id), std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(info))
}

#[tauri::command]
pub async fn newapi_invited_users(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<CoreEnvelope<newapi::NewApiAffiliatePage>, String> {
    let paths = paths.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::invited_users(
            &base_url,
            &access_token,
            opt_user_id(user_id),
            page.unwrap_or(1).max(1),
            page_size.unwrap_or(10).clamp(1, 100),
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(result))
}

#[tauri::command]
pub async fn newapi_transfer_aff_quota(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    quota: i64,
) -> Result<CoreEnvelope<bool>, String> {
    let paths = paths.inner().clone();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::transfer_aff_quota(&base_url, &access_token, opt_user_id(user_id), quota, std::time::Duration::from_secs(15))?;
        Ok::<bool, crate::core::models::CoreError>(true)
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(ok))
}

#[tauri::command]
pub async fn newapi_list_groups(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
) -> Result<CoreEnvelope<Vec<NewApiGroupInfo>>, String> {
    let paths = paths.inner().clone();
    let items = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::list_groups(&base_url, &access_token, opt_user_id(user_id), std::time::Duration::from_secs(15))
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(items))
}

#[tauri::command]
pub async fn newapi_list_models(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    group: Option<String>,
) -> Result<CoreEnvelope<Vec<String>>, String> {
    let paths = paths.inner().clone();
    let items = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::list_models(
            &base_url,
            &access_token,
            opt_user_id(user_id),
            group.as_deref(),
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(items))
}

#[tauri::command]
pub async fn newapi_create_token(
    paths: State<'_, Arc<ZCodePaths>>,
    base_url: Option<String>,
    access_token: Option<String>,
    input: NewApiCreateTokenInput,
) -> Result<CoreEnvelope<NewApiTokenDetail>, String> {
    let paths = paths.inner().clone();
    let detail = tauri::async_runtime::spawn_blocking(move || {
        let (base_url, access_token, user_id, _) =
            resolve_site_connection(&paths, base_url, access_token)?;
        newapi::create_token(
            &base_url,
            &access_token,
            opt_user_id(user_id),
            &input,
            std::time::Duration::from_secs(15),
        )
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
    .map_err(|e| e.to_string())?;
    Ok(CoreEnvelope::ok(detail))
}

/// API 密钥页：未接入返回 connected=false
#[tauri::command]
pub async fn newapi_keys(
    paths: State<'_, Arc<ZCodePaths>>,
) -> Result<CoreEnvelope<KeysPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || -> Result<KeysPayload, String> {
        let app = settings::load_settings(&paths);
        if app.site_base_url.is_empty() || app.site_access_token.is_empty() {
            return Ok(KeysPayload {
                connected: false,
                items: Vec::new(),
            });
        }
        let items = newapi::list_tokens(
            &app.site_base_url,
            &app.site_access_token,
            opt_user_id(app.site_user_id),
            std::time::Duration::from_secs(15),
        )
        .map_err(|e| e.to_string())?;
        Ok(KeysPayload {
            connected: true,
            items,
        })
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(payload))
}

#[tauri::command]
pub async fn newapi_delete_token(paths: State<'_, Arc<ZCodePaths>>, id: i64) -> Result<CoreEnvelope<bool>, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let app = settings::load_settings(&paths);
        newapi::delete_token(&app.site_base_url, &app.site_access_token, opt_user_id(app.site_user_id), id, std::time::Duration::from_secs(15))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(true))
}

#[tauri::command]
pub async fn newapi_set_token_status(
    paths: State<'_, Arc<ZCodePaths>>,
    id: i64,
    status: i64,
) -> Result<CoreEnvelope<bool>, String> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let app = settings::load_settings(&paths);
        newapi::set_token_status(&app.site_base_url, &app.site_access_token, opt_user_id(app.site_user_id), id, status, std::time::Duration::from_secs(15))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(true))
}

/// 使用日志：log_type / start / end 传 0 表示不过滤
#[tauri::command]
pub async fn newapi_logs(
    paths: State<'_, Arc<ZCodePaths>>,
    page: i64,
    page_size: i64,
    log_type: i64,
    start: i64,
    end: i64,
) -> Result<CoreEnvelope<NewApiLogsPayload>, String> {
    let paths = paths.inner().clone();
    let payload = tauri::async_runtime::spawn_blocking(
        move || -> Result<NewApiLogsPayload, String> {
            let app = settings::load_settings(&paths);
            newapi::list_logs(
                &app.site_base_url,
                &app.site_access_token,
                opt_user_id(app.site_user_id),
                page,
                page_size,
                log_type,
                start,
                end,
                std::time::Duration::from_secs(15),
            )
            .map_err(|e| e.to_string())
        },
    )
    .await
    .map_err(|e| format!("任务执行失败：{e}"))??;
    Ok(CoreEnvelope::ok(payload))
}
