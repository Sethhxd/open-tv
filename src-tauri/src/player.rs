//! Embedded player (Windows only): mpv renders straight into the main window (`--wid`), below the
//! transparent webview. The Angular UI on top talks to mpv over its JSON IPC pipe and positions
//! mpv's window (whole window, or the TiviMate-style preview box).
//!
//! mpv's window must be a *direct* child of the main window: nested inside another child window,
//! the transparent main window doesn't composite it and the desktop shows through.
use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, Manager};
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
            FindWindowExW, GetWindowThreadProcessId, HWND_BOTTOM, SWP_ASYNCWINDOWPOS,
            SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
            SetWindowPos,
        },
    },
    core::w,
};

use crate::{media_type, types::Channel};

const MAIN: &str = "main";

type Rect = (i32, i32, i32, i32);

static NEXT_ID: AtomicU32 = AtomicU32::new(0);
static MAIN_HWND: OnceLock<isize> = OnceLock::new();
static CURRENT: Mutex<Option<Current>> = Mutex::new(None);
/// Where the UI wants the video (physical px, main window client area); `None` = hidden.
static RECT: Mutex<Option<Rect>> = Mutex::new(None);

/// The one stream on screen. Starting another play replaces it.
struct Current {
    id: u32,
    token: Option<CancellationToken>,
    pid: Option<u32>,
    tx: mpsc::UnboundedSender<String>,
}

/// Lives as long as `mpv::play`; dropping it closes the player UI unless a newer play took over.
pub struct Player {
    id: u32,
    app: AppHandle,
    pub args: Vec<String>,
}

impl Player {
    /// Called once mpv is spawned: lets `stop()` end this playback and places its window.
    pub fn track(&self, token: CancellationToken, pid: Option<u32>) {
        if let Some(cur) = CURRENT.lock().unwrap().as_mut() {
            if cur.id == self.id {
                cur.token = Some(token);
                cur.pid = pid;
            }
        }
        // mpv creates its window shortly after start; place it as soon as it appears.
        tauri::async_runtime::spawn(async {
            for _ in 0..200 {
                if apply_rect() {
                    return;
                }
                sleep(Duration::from_millis(50)).await;
            }
        });
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        let mut cur = CURRENT.lock().unwrap();
        if cur.as_ref().is_some_and(|c| c.id == self.id) {
            *cur = None;
            drop(cur);
            let _ = self.app.emit_to(MAIN, "player-closed", ());
        }
    }
}

pub fn open(app: &AppHandle, channel: &Channel) -> Result<Player> {
    let main = app.get_webview_window(MAIN).context("no main window")?;
    let hwnd = *MAIN_HWND.get_or_init(|| main.hwnd().map(|h| h.0 as isize).unwrap_or_default());
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed) + 1;
    // One screen, one stream: replace whatever is playing.
    if let Some(old) = CURRENT
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|c| c.token.clone())
    {
        old.cancel();
    }
    let pipe = format!(r"\\.\pipe\fredtv-player-{id}");
    let (tx, rx) = mpsc::unbounded_channel();
    *CURRENT.lock().unwrap() = Some(Current {
        id,
        token: None,
        pid: None,
        tx,
    });
    connect(app.clone(), pipe.clone(), rx);

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
    if channel.media_type != media_type::LIVESTREAM {
        // Stay on the last frame so the UI can offer replay.
        args.push("--keep-open=yes".into());
    }
    app.emit_to(MAIN, "player-open", channel)?;
    Ok(Player {
        id,
        app: app.clone(),
        args,
    })
}

/// Stops the current playback (mpv is killed, `play` returns, the UI closes).
pub fn stop() {
    if let Some(token) = CURRENT
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|c| c.token.clone())
    {
        token.cancel();
    }
}

/// Forwards a raw JSON IPC line from the UI to the current mpv.
pub fn send(msg: String) -> Result<()> {
    CURRENT
        .lock()
        .unwrap()
        .as_ref()
        .context("nothing is playing")?
        .tx
        .send(msg + "\n")?;
    Ok(())
}

pub fn set_rect(rect: Option<Rect>) {
    *RECT.lock().unwrap() = rect;
    apply_rect();
}

/// Moves the current mpv window to `RECT`. Returns false if its window doesn't exist yet.
fn apply_rect() -> bool {
    let Some(&parent) = MAIN_HWND.get() else {
        return false;
    };
    let Some(pid) = CURRENT.lock().unwrap().as_ref().and_then(|c| c.pid) else {
        return false;
    };
    let rect = *RECT.lock().unwrap();
    unsafe {
        let parent = HWND(parent as _);
        // While switching channels the old mpv may still be closing: pick ours by process id.
        let mut child = None;
        loop {
            let Ok(next) = FindWindowExW(Some(parent), child, w!("mpv"), None) else {
                return false;
            };
            let mut owner = 0;
            GetWindowThreadProcessId(next, Some(&mut owner));
            if owner == pid {
                // Async: never block our UI thread on another process's message loop.
                let _ = match rect {
                    Some((x, y, w, h)) if w > 0 && h > 0 => SetWindowPos(
                        next,
                        Some(HWND_BOTTOM),
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS,
                    ),
                    _ => SetWindowPos(
                        next,
                        None,
                        0,
                        0,
                        0,
                        0,
                        SWP_HIDEWINDOW
                            | SWP_NOMOVE
                            | SWP_NOSIZE
                            | SWP_NOZORDER
                            | SWP_NOACTIVATE
                            | SWP_ASYNCWINDOWPOS,
                    ),
                };
                return true;
            }
            child = Some(next);
        }
    }
}

/// Messages sent before mpv's pipe exists are queued in the channel.
fn connect(app: AppHandle, pipe: String, mut rx: mpsc::UnboundedReceiver<String>) {
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
        let Some(client) = client else { return };
        let (r, mut w) = tokio::io::split(client);
        let mut lines = BufReader::new(r).lines();
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => if w.write_all(msg.as_bytes()).await.is_err() { break },
                    None => break, // replaced by a newer play
                },
                line = lines.next_line() => match line {
                    Ok(Some(line)) => { let _ = app.emit_to(MAIN, "mpv", line); }
                    _ => break,
                },
            }
        }
    });
}
