import { Injectable, NgZone } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Channel } from "./models/channel";

export type PlayerMode = "full" | "preview";

/**
 * The single embedded stream in the main window. mpv draws into a native host window under
 * the (transparent) webview; this service keeps that host lined up with the UI:
 * the whole window in "full" mode, the info panel's preview box in "preview" mode.
 */
@Injectable({ providedIn: "root" })
export class PlayerService {
  /** Set by the backend's player-open event; a new object on every play. */
  channel?: Channel;
  mode: PlayerMode = "full";
  /** Clip path for the opaque backdrop, cutting a hole where the preview video shows. */
  backdropClip = "none";
  private previewEl?: HTMLElement;
  private resizeObserver = new ResizeObserver(() => this.sync());

  constructor(private zone: NgZone) {
    const win = getCurrentWebviewWindow();
    win.listen<Channel>("player-open", (e) =>
      this.zone.run(() => {
        this.channel = e.payload;
        this.mode = "full";
        this.sync();
      }),
    );
    win.listen("player-closed", () =>
      this.zone.run(() => {
        this.channel = undefined;
        this.sync();
      }),
    );
    window.addEventListener("resize", () => this.sync());
  }

  get playing(): boolean {
    return !!this.channel;
  }

  get full(): boolean {
    return this.playing && this.mode === "full";
  }

  get preview(): boolean {
    return this.playing && this.mode === "preview";
  }

  setMode(mode: PlayerMode) {
    this.mode = mode;
    // The preview box only exists after the next render.
    setTimeout(() => this.sync());
  }

  /** Called by the home screen with its preview box (or undefined when it goes away). */
  setPreviewElement(el?: HTMLElement) {
    if (this.previewEl) this.resizeObserver.unobserve(this.previewEl);
    this.previewEl = el;
    if (el) this.resizeObserver.observe(el);
    this.sync();
  }

  stop() {
    invoke("player_stop").catch(console.error);
  }

  sync() {
    document.body.classList.toggle("player-body", this.playing);
    document.body.classList.toggle("player-preview", this.preview);
    let rect: DOMRect | undefined;
    if (this.full) rect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    else if (this.preview) {
      const r = this.previewEl?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) rect = r;
    }
    this.backdropClip =
      this.preview && rect
        ? `path(evenodd, "M0 0H${window.innerWidth}V${window.innerHeight}H0Z M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z")`
        : "none";
    const dpr = window.devicePixelRatio;
    invoke("player_rect", {
      x: Math.round((rect?.x ?? 0) * dpr),
      y: Math.round((rect?.y ?? 0) * dpr),
      width: Math.round((rect?.width ?? 0) * dpr),
      height: Math.round((rect?.height ?? 0) * dpr),
    }).catch(console.error);
  }
}
