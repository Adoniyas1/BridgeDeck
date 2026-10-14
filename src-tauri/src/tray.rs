//! Closing the window hides BridgeDeck to the tray (Windows) or menu bar (macOS) instead of quitting,
//! so pairing, file receiving and the AI relay keep running. Quit from the tray menu, or Cmd+Q on macOS.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Runtime, Window, WindowEvent,
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

/// A paired computer as the tray menu shows it (sent by the UI whenever the list changes).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayPeer {
    id: String,
    name: String,
    can_control: bool,
    can_receive: bool,
}

fn as_items<R: Runtime>(items: &[MenuItem<R>]) -> Vec<&dyn IsMenuItem<R>> {
    items.iter().map(|i| i as &dyn IsMenuItem<R>).collect()
}

fn build_menu<R: Runtime, M: Manager<R>>(app: &M, peers: &[TrayPeer], clipboard: bool) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Show BridgeDeck", true, None::<&str>)?;
    let control_items = peers
        .iter()
        .filter(|p| p.can_control)
        .map(|p| MenuItem::with_id(app, format!("control:{}", p.id), &p.name, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let send_items = peers
        .iter()
        .filter(|p| p.can_receive)
        .map(|p| MenuItem::with_id(app, format!("send:{}", p.id), &p.name, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let control = Submenu::with_items(app, "Control", !control_items.is_empty(), &as_items(&control_items))?;
    let send = Submenu::with_items(app, "Send files to", !send_items.is_empty(), &as_items(&send_items))?;
    let clipboard = CheckMenuItem::with_id(app, "clipboard", "Share clipboard", true, clipboard, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-remote", "Stop remote control", true, None::<&str>)?;
    let stop_ai = MenuItem::with_id(app, "stop-ai", "Stop the AI models", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit BridgeDeck", true, None::<&str>)?;
    let (line1, line2) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    Menu::with_items(app, &[&show, &line1, &control, &send, &clipboard, &line2, &stop, &stop_ai, &quit])
}

/// Rebuilds the tray menu with the current paired computers and settings.
#[tauri::command]
pub fn tray_update(app: AppHandle, peers: Vec<TrayPeer>, clipboard: bool) -> Result<(), String> {
    let menu = build_menu(&app, &peers, clipboard).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Tray choices the UI carries out (it has the device details and the tabs).
fn ui_action<R: Runtime>(app: &AppHandle<R>, action: serde_json::Value) {
    let _ = app.emit("tray-action", action);
}

pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &[], false)?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("BridgeDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "stop-remote" => crate::remote::host::stop_all(),
            "stop-ai" => {
                crate::watchdog::safety_stop_ai();
            }
            "quit" => app.exit(0),
            "clipboard" => ui_action(app, serde_json::json!({ "action": "clipboard" })),
            id => {
                if let Some(peer) = id.strip_prefix("control:") {
                    show_main(app);
                    ui_action(app, serde_json::json!({ "action": "control", "peer": peer }));
                } else if let Some(peer) = id.strip_prefix("send:") {
                    show_main(app);
                    ui_action(app, serde_json::json!({ "action": "send", "peer": peer }));
                }
            }
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
