import { Component, HostListener, NgZone, OnDestroy, OnInit } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ICONS } from "./icons";

interface Track {
  id: number;
  type: "video" | "audio" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
  "demux-h"?: number;
  codec?: string;
}

type Menu = "main" | "speed" | "audio" | "sub" | "quality" | "sleep";

const OBSERVED = [
  "pause",
  "time-pos",
  "duration",
  "volume",
  "mute",
  "paused-for-cache",
  "seeking",
  "seekable",
  "core-idle",
  "eof-reached",
  "demuxer-cache-time",
  "demuxer-cache-duration",
  "track-list",
  "speed",
  "playlist-pos",
  "playlist-count",
  "loop-file",
  "path",
  "video-params",
  "video-codec",
  "audio-codec-name",
  "estimated-vf-fps",
  "frame-drop-count",
  "video-bitrate",
  "audio-bitrate",
  "cache-speed",
  "hwdec-current",
];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_MINUTES = [0, 10, 15, 20, 30, 45, 60, 90, 120];
const HIDE_DELAY = 2500;
const LIVE_EDGE_SECONDS = 10;

@Component({
  selector: "app-player",
  templateUrl: "./player.component.html",
  styleUrl: "./player.component.css",
})
export class PlayerComponent implements OnInit, OnDestroy {
  icons = ICONS;
  speeds = SPEEDS;
  sleepMinutes = SLEEP_MINUTES;
  title = "";
  live = false;

  // mpv state, keyed by property name
  p: Record<string, any> = { pause: false, volume: 100, speed: 1, "core-idle": true };
  tracks: Track[] = [];

  controlsVisible = true;
  hoveringControls = false;
  fullscreen = false;
  mini = false;
  menu?: Menu;
  contextMenu?: { x: number; y: number };
  stats = false;
  bezel?: { icon: string; text?: string; key: number };
  volumeHint?: string;
  sleepAt?: number;

  scrubbing = false;
  hoverFraction?: number;
  scrubFraction?: number;

  private hideTimer?: number;
  private bezelTimer?: number;
  private volumeHintTimer?: number;
  private sleepTimer?: number;
  private saveVolumeTimer?: number;
  private lastScrubSeek = 0;
  private normalSize?: LogicalSize;
  private unlisten?: UnlistenFn;
  private lastSubId?: number;

  constructor(
    private route: ActivatedRoute,
    private zone: NgZone,
  ) {}

  async ngOnInit() {
    document.body.classList.add("player-body");
    const q = this.route.snapshot.queryParamMap;
    this.title = q.get("title") ?? "";
    this.live = q.get("live") === "true";
    this.unlisten = await getCurrentWebviewWindow().listen<string>("mpv", (e) =>
      this.zone.run(() => this.onMpv(JSON.parse(e.payload))),
    );
    OBSERVED.forEach((name, i) => this.cmd("observe_property", i + 1, name));
    this.poke();
  }

  ngOnDestroy() {
    this.unlisten?.();
  }

  private onMpv(msg: any) {
    if (msg.event !== "property-change") return;
    this.p[msg.name] = msg.data;
    if (msg.name === "track-list") this.tracks = msg.data ?? [];
    if (msg.name === "pause" || msg.name === "eof-reached") this.poke();
  }

  cmd(...command: any[]) {
    invoke("player_command", { msg: JSON.stringify({ command }) }).catch(console.error);
  }

  set(name: string, value: any) {
    this.cmd("set_property", name, value);
  }

  // ---------- derived state ----------

  get paused(): boolean {
    return !!this.p["pause"];
  }

  get ended(): boolean {
    return !this.live && !!this.p["eof-reached"];
  }

  get buffering(): boolean {
    return (
      !this.ended &&
      (!!this.p["paused-for-cache"] || !!this.p["seeking"] || (!!this.p["core-idle"] && !this.paused))
    );
  }

  get duration(): number {
    return this.p["duration"] ?? 0;
  }

  get position(): number {
    return this.p["time-pos"] ?? 0;
  }

  get hasTimeline(): boolean {
    return !this.live && this.duration > 0;
  }

  get playedFraction(): number {
    if (this.scrubFraction !== undefined) return this.scrubFraction;
    return this.duration ? this.position / this.duration : 0;
  }

  get bufferedFraction(): number {
    return this.duration ? Math.min(1, (this.p["demuxer-cache-time"] ?? 0) / this.duration) : 0;
  }

  get atLiveEdge(): boolean {
    return (this.p["demuxer-cache-time"] ?? 0) - this.position < LIVE_EDGE_SECONDS;
  }

  get muted(): boolean {
    return !!this.p["mute"] || this.p["volume"] == 0;
  }

  get volumeIcon(): string {
    if (this.muted) return ICONS.volumeOff;
    return this.p["volume"] < 50 ? ICONS.volumeDown : ICONS.volumeUp;
  }

  get hasPrev(): boolean {
    return (this.p["playlist-pos"] ?? 0) > 0;
  }

  get hasNext(): boolean {
    return (this.p["playlist-pos"] ?? 0) < (this.p["playlist-count"] ?? 1) - 1;
  }

  tracksOf(type: Track["type"]): Track[] {
    return this.tracks.filter((t) => t.type === type);
  }

  selected(type: Track["type"]): Track | undefined {
    return this.tracks.find((t) => t.type === type && t.selected);
  }

  trackLabel(t?: Track): string {
    if (!t) return "Off";
    if (t.type === "video" && t["demux-h"]) return `${t["demux-h"]}p`;
    return [t.title, t.lang].filter(Boolean).join(" - ") || `Track ${t.id}`;
  }

  get showControls(): boolean {
    return (
      this.controlsVisible ||
      this.paused ||
      this.ended ||
      this.hoveringControls ||
      this.scrubbing ||
      !!this.menu
    );
  }

  get sleepLabel(): string {
    if (!this.sleepAt) return "Off";
    return `${Math.max(1, Math.round((this.sleepAt - Date.now()) / 60000))} min`;
  }

  // ---------- auto-hide ----------

  @HostListener("document:mousemove")
  poke() {
    this.controlsVisible = true;
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => (this.controlsVisible = false), HIDE_DELAY);
  }

  @HostListener("document:mouseleave")
  onLeave() {
    if (!this.paused) this.controlsVisible = false;
  }

  // ---------- actions ----------

  togglePause() {
    if (this.ended) return this.replay();
    this.set("pause", !this.paused);
    this.flash(this.paused ? ICONS.play : ICONS.pause);
  }

  replay() {
    this.cmd("seek", 0, "absolute");
    this.set("pause", false);
  }

  seekBy(seconds: number) {
    this.cmd("seek", seconds, "relative");
    this.flash(seconds < 0 ? ICONS.rewind : ICONS.forward, `${Math.abs(seconds)} seconds`);
  }

  seekFraction(f: number, exact = true) {
    this.cmd("seek", f * this.duration, exact ? "absolute" : "absolute+keyframes");
  }

  goLive() {
    this.cmd("seek", (this.p["demuxer-cache-time"] ?? 0) - 1, "absolute");
  }

  changeVolume(delta: number) {
    const v = Math.max(0, Math.min(100, Math.round((this.p["volume"] ?? 100) + delta)));
    this.setVolume(v);
    this.showVolumeHint(`${v}%`);
  }

  setVolume(v: number) {
    this.set("volume", v);
    if (v > 0 && this.p["mute"]) this.set("mute", false);
    this.saveVolume();
  }

  toggleMute() {
    this.set("mute", !this.muted);
    if (this.p["volume"] == 0) this.set("volume", 50);
    this.showVolumeHint(this.muted ? `${this.p["volume"]}%` : "Muted");
  }

  // YouTube remembers volume across videos; mirror it into the app's volume setting.
  private saveVolume() {
    clearTimeout(this.saveVolumeTimer);
    this.saveVolumeTimer = window.setTimeout(async () => {
      this.saveVolumeTimer = undefined;
      try {
        const settings: any = await invoke("get_settings");
        settings.volume = Math.round(this.p["volume"]);
        await invoke("update_settings", { settings });
      } catch (e) {
        console.error(e);
      }
    }, 1000);
  }

  toggleCaptions() {
    const current = this.selected("sub");
    if (current) {
      this.lastSubId = current.id;
      this.set("sid", "no");
    } else {
      const subs = this.tracksOf("sub");
      if (!subs.length) return;
      this.set("sid", this.lastSubId ?? subs[0].id);
    }
  }

  selectTrack(type: Track["type"], id: number | "no") {
    this.set({ video: "vid", audio: "aid", sub: "sid" }[type], id);
    this.menu = undefined;
  }

  setSpeed(speed: number) {
    this.set("speed", speed);
    this.menu = undefined;
  }

  stepSpeed(dir: number) {
    const i = SPEEDS.indexOf(this.p["speed"]);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))];
    this.set("speed", next);
    this.showVolumeHint(`${next}x`);
  }

  setSleep(minutes: number) {
    clearTimeout(this.sleepTimer);
    this.sleepAt = minutes ? Date.now() + minutes * 60000 : undefined;
    if (minutes) this.sleepTimer = window.setTimeout(() => this.set("pause", true), minutes * 60000);
    this.menu = undefined;
  }

  toggleLoop() {
    this.set("loop-file", this.p["loop-file"] === "inf" || this.p["loop-file"] === true ? "no" : "inf");
    this.contextMenu = undefined;
  }

  get looping(): boolean {
    return this.p["loop-file"] === "inf" || this.p["loop-file"] === true;
  }

  async copyUrl() {
    if (this.p["path"]) await writeText(this.p["path"]);
    this.contextMenu = undefined;
  }

  async toggleFullscreen() {
    if (this.mini) await this.toggleMini();
    this.fullscreen = !this.fullscreen;
    await getCurrentWindow().setFullscreen(this.fullscreen);
  }

  async toggleMini() {
    const win = getCurrentWindow();
    if (this.fullscreen) await this.toggleFullscreen();
    this.mini = !this.mini;
    if (this.mini) {
      const factor = await win.scaleFactor();
      this.normalSize = (await win.innerSize()).toLogical(factor);
      await win.setSize(new LogicalSize(480, 270));
    } else if (this.normalSize) {
      await win.setSize(this.normalSize);
    }
    await win.setAlwaysOnTop(this.mini);
  }

  minimize() {
    getCurrentWindow().minimize();
  }

  toggleMaximize() {
    getCurrentWindow().toggleMaximize();
  }

  close() {
    getCurrentWindow().close();
  }

  // ---------- video surface ----------

  onSurfaceClick() {
    if (this.menu || this.contextMenu) {
      this.menu = this.contextMenu = undefined;
      return;
    }
    this.togglePause();
  }

  onContextMenu(e: MouseEvent) {
    e.preventDefault();
    this.menu = undefined;
    this.contextMenu = { x: e.clientX, y: e.clientY };
  }

  // ---------- progress bar ----------

  private fractionAt(e: MouseEvent, bar: HTMLElement): number {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }

  onBarHover(e: MouseEvent, bar: HTMLElement) {
    this.hoverFraction = this.fractionAt(e, bar);
  }

  onBarDown(e: MouseEvent, bar: HTMLElement) {
    if (e.button !== 0) return;
    this.scrubbing = true;
    this.scrubFraction = this.fractionAt(e, bar);
    this.seekFraction(this.scrubFraction, false);
    const move = (ev: MouseEvent) =>
      this.zone.run(() => {
        this.scrubFraction = this.hoverFraction = this.fractionAt(ev, bar);
        // ponytail: fixed 100ms throttle on keyframe seeks while dragging; tune if seeking lags on slow streams
        if (Date.now() - this.lastScrubSeek > 100) {
          this.lastScrubSeek = Date.now();
          this.seekFraction(this.scrubFraction, false);
        }
      });
    const up = (ev: MouseEvent) =>
      this.zone.run(() => {
        this.seekFraction(this.fractionAt(ev, bar));
        this.scrubbing = false;
        this.scrubFraction = undefined;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      });
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---------- feedback ----------

  private flash(icon: string, text?: string) {
    clearTimeout(this.bezelTimer);
    this.bezel = { icon, text, key: Date.now() };
    this.bezelTimer = window.setTimeout(() => (this.bezel = undefined), 600);
  }

  private showVolumeHint(text: string) {
    clearTimeout(this.volumeHintTimer);
    this.volumeHint = text;
    this.volumeHintTimer = window.setTimeout(() => (this.volumeHint = undefined), 800);
  }

  // ---------- keyboard (YouTube shortcuts) ----------

  @HostListener("document:keydown", ["$event"])
  onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const seekable = !this.live || this.p["seekable"] !== false;
    switch (e.key) {
      case " ":
      case "k":
        this.togglePause();
        break;
      case "j":
        if (seekable) this.seekBy(-10);
        break;
      case "l":
        if (seekable) this.seekBy(10);
        break;
      case "ArrowLeft":
        if (seekable) this.seekBy(-5);
        break;
      case "ArrowRight":
        if (seekable) this.seekBy(5);
        break;
      case "ArrowUp":
        this.changeVolume(5);
        break;
      case "ArrowDown":
        this.changeVolume(-5);
        break;
      case "m":
        this.toggleMute();
        break;
      case "f":
        this.toggleFullscreen();
        break;
      case "c":
        this.toggleCaptions();
        break;
      case "i":
        this.toggleMini();
        break;
      case "Escape":
        if (this.menu || this.contextMenu) this.menu = this.contextMenu = undefined;
        else if (this.fullscreen) this.toggleFullscreen();
        else if (this.mini) this.toggleMini();
        break;
      case "Home":
        if (this.hasTimeline) this.seekFraction(0);
        break;
      case "End":
        if (this.hasTimeline) this.seekFraction(0.999);
        else if (this.live) this.goLive();
        break;
      case ",":
        if (this.paused) this.cmd("frame-back-step");
        break;
      case ".":
        if (this.paused) this.cmd("frame-step");
        break;
      case "<":
        if (!this.live) this.stepSpeed(-1);
        break;
      case ">":
        if (!this.live) this.stepSpeed(1);
        break;
      case "N":
        if (this.hasNext) this.cmd("playlist-next");
        break;
      case "P":
        if (this.hasPrev) this.cmd("playlist-prev");
        break;
      default:
        if (/^[0-9]$/.test(e.key) && this.hasTimeline) this.seekFraction(+e.key / 10);
        else return;
    }
    e.preventDefault();
    this.poke();
  }

  // ---------- formatting ----------

  fmt(seconds: number): string {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  kbps(bits?: number): string {
    return bits ? `${Math.round(bits / 1000)} Kbps` : "-";
  }
}
