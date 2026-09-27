pub mod commands;
pub mod core;
pub mod platform;

use platform::paths::ZCodePaths;
use std::cell::RefCell;
use std::io::Cursor;
use std::rc::Rc;
use std::sync::Arc;
use tauri::image::Image;
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent};

pub fn run() {
    let shared_paths = Arc::new(ZCodePaths::new());
    if let Err(error) = shared_paths.ensure_app_directories() {
        eprintln!("[ZMate] failed to prepare app data dir: {error}");
    }

    let single_instance_guard = match platform::single_instance::acquire(&shared_paths) {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("[ZMate] another instance is already running; exiting: {error}");
            let activated = platform::single_instance::request_existing_instance_activation();
            if !activated {
                eprintln!("[ZMate] failed to activate the running instance");
            }
            return;
        }
    };
    let single_instance_guard = Rc::new(RefCell::new(Some(single_instance_guard)));

    #[cfg(target_os = "windows")]
    let _updater_install_dir_arg = platform::update::windows_current_install_dir_arg();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(shared_paths.clone())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                        #[cfg(target_os = "macos")]
                        platform::dock::set_dock_visible(false);
                    }
                });
            }

            let tray_menu = commands::tray_menu::create_tray_menu(app.handle())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            let tray_icon = load_tray_template_icon()
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("ZMate")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    commands::tray_menu::handle_tray_menu_event(app, &event.id.0);
                })
                .show_menu_on_left_click(true)
                .build(app)?;

            schedule_startup_main_window_reveal(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::providers::load_providers,
            commands::providers::fetch_provider_models,
            commands::providers::test_provider_connectivity,
            commands::providers::test_provider,
            commands::providers::test_provider_model,
            commands::providers::stream_test_provider_model,
            commands::providers::upsert_provider,
            commands::providers::remove_provider,
            commands::providers::set_provider_enabled,
            commands::newapi::newapi_probe_site,
            commands::newapi::newapi_list_tokens,
            commands::newapi::newapi_reveal_token_key,
            commands::newapi::newapi_affiliate_info,
            commands::newapi::newapi_invited_users,
            commands::newapi::newapi_transfer_aff_quota,
            commands::newapi::newapi_list_groups,
            commands::newapi::newapi_list_models,
            commands::newapi::newapi_create_token,
            commands::newapi::newapi_site_connection_status,
            commands::newapi::newapi_user_profile,
            commands::newapi::newapi_login_with_password,
            commands::newapi::newapi_verify_site_connection,
            commands::newapi::newapi_save_site_connection,
            commands::newapi::newapi_clear_site_connection,
            commands::newapi::newapi_site_usage,
            commands::newapi::newapi_wallet,
            commands::newapi::newapi_redeem,
            commands::newapi::newapi_keys,
            commands::newapi::newapi_delete_token,
            commands::newapi::newapi_set_token_status,
            commands::newapi::newapi_logs,
            commands::mcp::load_mcp_servers,
            commands::mcp::upsert_mcp_server,
            commands::mcp::set_mcp_server_enabled,
            commands::mcp::remove_mcp_server,
            commands::skills::load_installed_skills,
            commands::skills::load_skill_backups,
            commands::skills::import_skill,
            commands::skills::remove_skill,
            commands::skills::restore_skill_backup,
            commands::skills::delete_skill_backup,
            commands::custom_instructions::load_custom_instruction_state,
            commands::custom_instructions::preview_custom_instruction_apply,
            commands::custom_instructions::apply_custom_instruction,
            commands::custom_instructions::clear_custom_instruction_block,
            commands::custom_instructions::rollback_custom_instruction,
            commands::sessions::list_sessions,
            commands::sessions::get_session_overview,
            commands::sessions::get_session_detail,
            commands::sessions::get_session_stats,
            commands::system::load_app_state,
            commands::system::set_check_zcode_running,
            commands::system::is_zcode_running,
            commands::system::load_zcode_proxy,
            commands::system::set_zcode_proxy,
            commands::system::restart_zcode,
            commands::system::diagnose,
            commands::system::clean,
            commands::system::get_system_info,
            commands::system::graceful_restart_for_update,
            commands::system::check_update_installability,
            commands::system::open_path,
            commands::dashboard::load_dashboard,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ZMate");

    let activation_watcher_guard = platform::single_instance::start_activation_watcher({
        let handle = app.handle().clone();
        move || commands::tray_menu::show_main_window(&handle)
    })
    .map_err(|error| {
        eprintln!("[ZMate] failed to start single-instance activation watcher: {error}");
        error
    })
    .ok();
    let activation_watcher_guard = Rc::new(RefCell::new(activation_watcher_guard));
    let single_instance_guard_for_exit = Rc::clone(&single_instance_guard);
    let activation_watcher_guard_for_exit = Rc::clone(&activation_watcher_guard);

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let _ = activation_watcher_guard_for_exit.borrow_mut().take();
            let _ = single_instance_guard_for_exit.borrow_mut().take();
        }

        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            commands::tray_menu::show_main_window(_app_handle);
        }
    });
}

// macOS 托盘走模板图标（黑色 glyph，系统自动适配菜单栏明暗）；
// Windows 没有 template 机制，深色任务栏是默认形态，用白色 glyph 保证可见性。
#[cfg(target_os = "macos")]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon-white.png");

fn load_tray_template_icon() -> Result<Image<'static>, String> {
    let reader = image::ImageReader::new(Cursor::new(TRAY_ICON_BYTES))
        .with_guessed_format()
        .map_err(|e| format!("failed to guess tray icon format: {e}"))?;
    let decoded = reader
        .decode()
        .map_err(|e| format!("failed to decode tray icon png: {e}"))?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    Ok(Image::new_owned(decoded.into_raw(), width, height))
}

fn schedule_startup_main_window_reveal(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));
        commands::tray_menu::show_main_window(&handle);
    });
}
