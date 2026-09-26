use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::{AppHandle, Manager, Wry};

const OPEN_MAIN_ID: &str = "tray_open_main";
const QUIT_ID: &str = "tray_quit";

pub fn create_tray_menu(app: &AppHandle) -> Result<Menu<Wry>, String> {
    MenuBuilder::new(app)
        .item(
            &MenuItem::with_id(app, OPEN_MAIN_ID, "打开 ZMate", true, None::<&str>)
                .map_err(|e| e.to_string())?,
        )
        .separator()
        .item(
            &MenuItem::with_id(app, QUIT_ID, "退出", true, None::<&str>)
                .map_err(|e| e.to_string())?,
        )
        .build()
        .map_err(|e| e.to_string())
}

pub fn handle_tray_menu_event(app: &AppHandle, event_id: &str) {
    if event_id == OPEN_MAIN_ID {
        show_main_window(app);
        return;
    }
    if event_id == QUIT_ID {
        app.exit(0);
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        crate::platform::dock::set_dock_visible(true);
    }
}
