//! The Rust shell around the WorshipFluent bridge. The app logic (ProPresenter
//! polling, the server socket, pairing) lives in TypeScript; this side owns what
//! only a native process can do: the tray icon, one instance at a time, start at
//! login, the pairing code the installer handed over, and a fast LAN scan.

use regex::Regex;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;

/// The one-time pairing code the installer's file name carried, if any.
///
/// Sources, in order: `--pair-code=XXXX` on the command line (the NSIS hook
/// launches the app with it), a `pairing-code.txt` next to the executable or in
/// the app's data folder (the hook writes it when it can't pass arguments), or
/// the executable's own name for the portable build. A tolerant pattern so
/// `WorshipFluent-Setup-K7PR4Q2MAB (1).exe` still pairs.
#[tauri::command]
fn installer_code(app: AppHandle) -> Option<String> {
    let re = Regex::new(r"(?i)setup[-_ ]([23456789A-HJ-NP-Z]{8,12})").unwrap();
    for arg in std::env::args() {
        if let Some(code) = arg.strip_prefix("--pair-code=") {
            return Some(code.to_uppercase());
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = vec![];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("pairing-code.txt"));
        }
        if let Some(name) = exe.file_name().and_then(|n| n.to_str()) {
            if let Some(m) = re.captures(name) {
                return Some(m[1].to_uppercase());
            }
        }
    }
    if let Ok(dir) = app.path().app_data_dir() {
        candidates.push(dir.join("pairing-code.txt"));
    }
    for path in candidates {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let code: String = text.trim().to_uppercase();
            let _ = std::fs::remove_file(&path); // one use
            if (8..=12).contains(&code.len()) {
                return Some(code);
            }
        }
    }
    None
}

#[derive(Serialize)]
struct ScanHit {
    host: String,
    port: u16,
}

/// Hosts on this computer's /24 networks with `port` open. The TypeScript side
/// confirms each with ProPresenter's own API before trusting it.
#[tauri::command]
async fn scan_lan(port: u16) -> Vec<ScanHit> {
    let mut hits = vec![];
    let mut bases: Vec<Ipv4Addr> = vec![];
    // The address we'd use to reach the internet tells us our LAN; no traffic is sent.
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(SocketAddr::V4(local)) = sock.local_addr() {
                bases.push(*local.ip());
            }
        }
    }
    if bases.is_empty() {
        return hits;
    }
    let mut tasks = tokio::task::JoinSet::new();
    for base in bases {
        let o = base.octets();
        for last in 1..=254u8 {
            if last == o[3] {
                continue;
            }
            let ip = IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], last));
            tasks.spawn(async move {
                let addr = SocketAddr::new(ip, port);
                match tokio::time::timeout(Duration::from_millis(400), tokio::net::TcpStream::connect(addr)).await {
                    Ok(Ok(_)) => Some(ip.to_string()),
                    _ => None,
                }
            });
        }
    }
    while let Some(res) = tasks.join_next().await {
        if let Ok(Some(host)) = res {
            hits.push(ScanHit { host, port });
        }
    }
    hits.sort_by(|a, b| a.host.cmp(&b.host));
    hits
}

/// Tray state the UI reports: "unpaired" | "searching" | "ready" | "live".
#[tauri::command]
fn set_tray(app: AppHandle, state: String, title: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("WorshipFluent · {title}")));
        let icon_bytes: &[u8] = match state.as_str() {
            "live" => include_bytes!("../icons/tray-live.png"),
            "ready" => include_bytes!("../icons/tray-ready.png"),
            "searching" => include_bytes!("../icons/tray-searching.png"),
            _ => include_bytes!("../icons/tray-unpaired.png"),
        };
        if let Ok(img) = tauri::image::Image::from_bytes(icon_bytes) {
            let _ = tray.set_icon(Some(img));
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--tray"])))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![installer_code, scan_lan, set_tray])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open window", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause cues", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-unpaired.png"))?)
                .tooltip("WorshipFluent")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "pause" => {
                        let _ = app.emit("toggle-pause", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Launched at login: stay in the tray.
            if std::env::args().any(|a| a == "--tray") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the bridge running; Quit is in the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running WorshipFluent");
}
