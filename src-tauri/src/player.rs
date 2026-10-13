//! Embedded player (Windows only): mpv renders into a transparent Tauri window via `--wid`,
//! the webview on top draws the controls and talks to mpv through its JSON IPC pipe.
use std::{
    collections::HashMap,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::ClientOptions,
    sync::mpsc,
    time::sleep,
};
use tokio_util::sync::CancellationToken;
use windows::{
    Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            FindWindowExW, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
        },
    },
    core::w,
};

use crate::{media_type, types::Channel};

static NEXT_ID: AtomicU32 = AtomicU32::new(0);
static PIPES: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> =
    LazyLock::new(Default::default);

/// Owns the player window; dropping it closes the window.
pub struct Player {
    window: WebviewWindow,
    pub args: Vec<String>,
}

impl Player {
    /// Closing the window stops playback.
    pub fn cancel_on_close(&self, token: CancellationToken) {
        self.window.on_window_event(move |e| {
            if let WindowEvent::Destroyed = e {
                token.cancel();
            }
        });
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        let _ = self.window.destroy();
    }
}

pub fn open(app: &AppHandle, channel: &Channel) -> Result<Player> {
    let label = format!("player-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let live = channel.media_type == media_type::LIVESTREAM;
    let title: String = url::form_urlencoded::byte_serialize(channel.name.as_bytes()).collect();
    let url = format!("player?live={live}&title={title}");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(&channel.name)
        .inner_size(1280., 720.)
        .min_inner_size(480., 270.)
        .decorations(false)
        .transparent(true)
        .build()?;
    let hwnd = window.hwnd()?.0 as isize;
    let pipe = format!(r"\\.\pipe\fredtv-{label}");
    let mut args = vec![
        format!("--wid={hwnd}"),
        format!("--input-ipc-server={pipe}"),
        "--force-window=immediate".into(),
        "--no-osc".into(),
        "--osd-level=0".into(),
        "--no-input-default-bindings".into(),
        "--input-cursor=no".into(),
        "--cursor-autohide=no".into(),
    ];
    if !live {
        // Stay on the last frame so the UI can offer replay, like YouTube.
        args.push("--keep-open=yes".into());
    }
    tauri::async_runtime::spawn(push_video_to_back(hwnd));
    connect(window.clone(), pipe);
    Ok(Player { window, args })
}

/// Forwards a raw JSON IPC line from the player UI to its mpv instance.
pub fn send(label: &str, msg: String) -> Result<()> {
    PIPES
        .lock()
        .unwrap()
        .get(label)
        .context("player not connected")?
        .send(msg + "\n")?;
    Ok(())
}

/// Messages sent before mpv's pipe exists are queued in the channel.
fn connect(window: WebviewWindow, pipe: String) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let label = window.label().to_string();
    PIPES.lock().unwrap().insert(label.clone(), tx);
    tauri::async_runtime::spawn(async move {
        let mut client = None;
        for _ in 0..200 {
            match ClientOptions::new().open(&pipe) {
                Ok(c) => {
                    client = Some(c);
                    break;
                }
                Err(_) => sleep(Duration::from_millis(50)).await,
            }
        }
        if let Some(client) = client {
            let (r, mut w) = tokio::io::split(client);
            let mut lines = BufReader::new(r).lines();
            loop {
                tokio::select! {
                    Some(msg) = rx.recv() => if w.write_all(msg.as_bytes()).await.is_err() { break },
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => { let _ = window.emit_to(&label, "mpv", line); }
                        _ => break,
                    },
                }
            }
        }
        PIPES.lock().unwrap().remove(&label);
    });
}

/// mpv creates its child window above the webview; push it to the bottom so the UI stays on top.
async fn push_video_to_back(parent: isize) {
    for _ in 0..100 {
        let found = unsafe {
            FindWindowExW(Some(HWND(parent as _)), None, w!("mpv"), None)
                .map(|child| {
                    SetWindowPos(
                        child,
                        Some(HWND_BOTTOM),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                })
                .is_ok()
        };
        if found {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
}
