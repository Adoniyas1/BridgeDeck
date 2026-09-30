//! Closing the window hides BridgeDeck to the tray (Windows) or menu bar (macOS) instead of quitting,
//! so pairing, file receiving and the AI relay keep running. Quit from the tray menu, or Cmd+Q on macOS.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Runtime, Window, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

const MAIN_WINDOW: &str = "main";

/// The first hide in a session says where BridgeDeck went.
static HIDE_EXPLAINED: AtomicBool = AtomicBool::new(false);

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show BridgeDeck", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-remote", "Stop remote control", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit BridgeDeck", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("BridgeDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "stop-remote" => crate::remote::host::stop_all(),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != MAIN_WINDOW {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    if !HIDE_EXPLAINED.swap(true, Ordering::Relaxed) {
        let where_ = if cfg!(target_os = "macos") { "menu bar" } else { "system tray" };
        let _ = window
            .app_handle()
            .notification()
            .builder()
            .title("BridgeDeck is still running")
            .body(format!("It keeps your computers connected. Open or quit it from the {where_} icon."))
            .show();
    }
}
