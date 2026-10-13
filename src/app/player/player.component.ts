import { Component, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ICONS } from "./icons";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { ViewMode } from "../models/viewMode";
import { SortType } from "../models/sortType";
import { EpgService, NowNext, Programme, clockTime } from "../epg.service";
import { EpgGridComponent } from "../epg-grid/epg-grid.component";
import { MemoryService } from "../memory.service";
import { PlayerService } from "../player.service";

interface Track {
  id: number;
  type: "video" | "audio" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
  "demux-h"?: number;
  codec?: string;
}

interface MenuItem {
  label: string;
  value?: string;
  checked?: boolean;
  submenu?: boolean;
  action: () => void;
}

type Overlay = "none" | "list" | "groups" | "guide" | "settings";
type SettingsPage = "main" | "audio" | "sub" | "video" | "aspect" | "speed" | "sleep";

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
const SLEEP_MINUTES = [0, 15, 30, 45, 60, 90, 120];
const ASPECTS: { label: string; props: Record<string, any> }[] = [
  { label: "Auto", props: { "video-aspect-override": "-1", keepaspect: true, panscan: 0 } },
  { label: "16:9", props: { "video-aspect-override": "16:9", keepaspect: true, panscan: 0 } },
  { label: "4:3", props: { "video-aspect-override": "4:3", keepaspect: true, panscan: 0 } },
  { label: "Fill (zoom)", props: { "video-aspect-override": "-1", keepaspect: true, panscan: 1 } },
  { label: "Stretch", props: { "video-aspect-override": "-1", keepaspect: false, panscan: 0 } },
];
const PAGE_SIZE = 36;
const MAX_PAGES = 100; // ponytail: caps a group at 3600 channels; raise if a provider has bigger groups
const BANNER_MS = 4500;
const OVERLAY_IDLE_MS = 15_000;
const ZAP_SETTLE_MS = 300; // don't open a stream for every channel flown past
const LONG_PRESS_MS = 600;
const NUMBER_ENTRY_MS = 1500;

@Component({
  selector: "app-player",
  templateUrl: "./player.component.html",
  styleUrl: "./player.component.css",
})
export class PlayerComponent implements OnInit, OnDestroy {
  @ViewChild(EpgGridComponent) grid?: EpgGridComponent;
  icons = ICONS;
  time = clockTime;

  // what's playing
  channel!: Channel;
  live = false;
  catchup?: Programme;
  nowNext: NowNext = {};
  private prevChannel?: Channel;

  // zapping list = the playing channel's group; list overlay may browse another group
  channels: Channel[] = [];
  currentIndex = -1;
  listChannels: Channel[] = [];
  listGroupName = "";
  listIndex = 0;
  groups: Channel[] = [];
  groupIndex = 0;
  groupsReturn: "list" | "guide" = "list";
  rowNow = new Map<number, Programme | null>();

  // mpv state, keyed by property name
  p: Record<string, any> = { pause: false, volume: 100, speed: 1, "core-idle": true };
  tracks: Track[] = [];

  overlay: Overlay = "none";
  settingsPage: SettingsPage = "main";
  menuIndex = 0;
  bannerVisible = true;
  pendingIndex?: number;
  typed = "";
  fullscreen = false;
  mini = false;
  stats = false;
  aspect = 0;
  sleepAt?: number;
  volumeHint?: string;
  pauseFlash?: number;
  clock = Date.now();

  scrubbing = false;
  hoverFraction?: number;
  scrubFraction?: number;

  private bannerTimer?: number;
  private overlayTimer?: number;
  private zapTimer?: number;
  private numberTimer?: number;
  private longPress?: number;
  private longPressFired = false;
  private volumeHintTimer?: number;
  private sleepTimer?: number;
  private saveVolumeTimer?: number;
  private clockTimer?: number;
  private lastScrubSeek = 0;
  private normalSize?: LogicalSize;
  private unlisten?: UnlistenFn;
  private lastSubId?: number;
  private epgSeq = 0;

  constructor(
    private zone: NgZone,
    public player: PlayerService,
    public epg: EpgService,
    private memory: MemoryService,
  ) {}

  async ngOnInit() {
    this.channel = { ...this.player.channel! };
    this.live = this.channel.media_type === MediaType.livestream;
    this.unlisten = await getCurrentWebviewWindow().listen<string>("mpv", (e) =>
      this.zone.run(() => this.onMpv(JSON.parse(e.payload))),
    );
    OBSERVED.forEach((name, i) => this.cmd("observe_property", i + 1, name));
    this.clockTimer = window.setInterval(() => (this.clock = Date.now()), 5000);
    this.showBanner();
    this.loadNowNext();
    invoke<any>("get_settings")
      .then((s) => (this.memory.trayEnabled = s.enable_tray_icon ?? true))
      .catch(console.error);
    if (this.canZap) this.loadZapList();
  }

  ngOnDestroy() {
    this.unlisten?.();
    clearInterval(this.clockTimer);
  }

  private onMpv(msg: any) {
    if (msg.event !== "property-change") return;
    this.p[msg.name] = msg.data;
    if (msg.name === "track-list") this.tracks = msg.data ?? [];
  }

  cmd(...command: any[]) {
    invoke("player_command", { msg: JSON.stringify({ command }) }).catch(console.error);
  }

  set(name: string, value: any) {
    this.cmd("set_property", name, value);
  }

  // ---------- derived state ----------

  /** Real channel from the database (not catch-up/restream), so it has neighbours to zap to. */
  get canZap(): boolean {
    return this.live && (this.channel.id ?? -1) > 0 && this.channel.source_id != null;
  }

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
    return (!this.live || !!this.catchup) && this.duration > 0;
  }

  get playedFraction(): number {
    if (this.scrubFraction !== undefined) return this.scrubFraction;
    return this.duration ? this.position / this.duration : 0;
  }

  get bufferedFraction(): number {
    return this.duration ? Math.min(1, (this.p["demuxer-cache-time"] ?? 0) / this.duration) : 0;
  }

  get muted(): boolean {
    return !!this.p["mute"] || this.p["volume"] == 0;
  }

  get volumeIcon(): string {
    if (this.muted) return ICONS.volumeOff;
    return this.p["volume"] < 50 ? ICONS.volumeDown : ICONS.volumeUp;
  }

  get hasNextEpisode(): boolean {
    return (this.p["playlist-pos"] ?? 0) < (this.p["playlist-count"] ?? 1) - 1;
  }

  /** Channel the banner describes: the one being zapped to, else the one playing. */
  get bannerChannel(): Channel | undefined {
    return this.pendingIndex !== undefined ? this.channels[this.pendingIndex] : this.channel;
  }

  get bannerNumber(): number | undefined {
    const i = this.pendingIndex ?? this.currentIndex;
    return i >= 0 ? i + 1 : undefined;
  }

  get badges(): string[] {
    const out: string[] = [];
    const h = this.p["video-params"]?.h;
    if (h) out.push(h >= 2160 ? "4K" : h >= 1080 ? "FHD" : h >= 720 ? "HD" : "SD");
    if (h) out.push(`${h}p`);
    const fps = this.p["estimated-vf-fps"];
    if (fps) out.push(`${Math.round(fps)} fps`);
    if (this.p["audio-codec-name"]) out.push(String(this.p["audio-codec-name"]).toUpperCase());
    if (this.tracksOf("sub").length) out.push("CC");
    return out;
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

  get chromeVisible(): boolean {
    return this.bannerVisible || this.overlay !== "none" || this.scrubbing || this.ended;
  }

  // ---------- channel lists ----------

  private async fetchGroup(groupId: number | undefined, onPage: (all: Channel[]) => void) {
    const all: Channel[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch: Channel[] = await invoke("search", {
        filters: {
          source_ids: [this.channel.source_id],
          view_type: ViewMode.All,
          media_types: [MediaType.livestream],
          page,
          group_id: groupId,
          query: "",
          use_keywords: false,
          sort: SortType.provider,
        },
      });
      all.push(...batch);
      onPage(all.slice());
      if (batch.length < PAGE_SIZE) break;
    }
  }

  private async loadZapList() {
    this.listGroupName = this.channel.group ?? "All channels";
    await this.fetchGroup(this.channel.group_id, (all) => {
      this.channels = all;
      this.currentIndex = all.findIndex((c) => c.id === this.channel.id);
      if (this.overlay !== "list") this.listChannels = all;
    });
  }

  private async loadGroups() {
    if (this.groups.length) return;
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch: Channel[] = await invoke("search", {
          filters: {
            source_ids: [this.channel.source_id],
            view_type: ViewMode.Categories,
            media_types: [MediaType.livestream],
            page,
            query: "",
            use_keywords: false,
            sort: SortType.provider,
          },
        });
        this.groups = this.groups.concat(batch);
        if (batch.length < PAGE_SIZE) break;
      }
    } catch (e) {
      console.error(e);
    }
  }

  async loadRowEpg(c: Channel) {
    if (c.id == null || this.rowNow.has(c.id)) return;
    this.rowNow.set(c.id, null);
    const list = await this.epg.get(c);
    this.rowNow.set(c.id, this.epg.nowNext(list).now ?? null);
  }

  private async loadNowNext() {
    const seq = ++this.epgSeq;
    const channel = this.bannerChannel;
    this.nowNext = {};
    if (!channel || this.catchup) return;
    const list = await this.epg.get(channel);
    if (seq === this.epgSeq) this.nowNext = this.epg.nowNext(list);
  }

  // ---------- zapping ----------

  zapBy(step: number) {
    if (!this.channels.length) return;
    const n = this.channels.length;
    const base = this.pendingIndex ?? Math.max(0, this.currentIndex);
    this.pendingIndex = (((base + step) % n) + n) % n;
    this.showBanner();
    this.loadNowNext();
    clearTimeout(this.zapTimer);
    this.zapTimer = window.setTimeout(() => this.tune(this.channels[this.pendingIndex!]), ZAP_SETTLE_MS);
  }

  tune(target?: Channel, fromList?: Channel[]) {
    clearTimeout(this.zapTimer);
    this.pendingIndex = undefined;
    if (!target?.url) return;
    if (fromList) this.channels = fromList;
    if (target.id !== this.channel.id || this.catchup) this.prevChannel = this.channel;
    this.channel = target;
    this.catchup = undefined;
    this.currentIndex = this.channels.findIndex((c) => c.id === target.id);
    // ponytail: zaps reuse the first channel's mpv headers/user-agent (same source); per-channel custom headers aren't reapplied
    this.cmd("loadfile", target.url, "replace");
    this.set("pause", false);
    invoke("add_last_watched", { id: target.id }).catch(console.error);
    this.showBanner();
    this.loadNowNext();
  }

  playArchive({ channel, programme }: { channel: Channel; programme: Programme }) {
    if (!programme.timeshift_url) return;
    this.prevChannel = this.channel;
    this.channel = channel;
    this.currentIndex = this.channels.findIndex((c) => c.id === channel.id);
    this.catchup = programme;
    this.cmd("loadfile", programme.timeshift_url, "replace");
    this.set("pause", false);
    this.closeOverlay();
    this.showBanner();
  }

  // ---------- overlays ----------

  showBanner() {
    this.bannerVisible = true;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      if (!this.scrubbing) this.bannerVisible = false;
    }, BANNER_MS);
  }

  private poke() {
    clearTimeout(this.overlayTimer);
    if (this.overlay !== "none" && this.overlay !== "settings") {
      this.overlayTimer = window.setTimeout(() => this.closeOverlay(), OVERLAY_IDLE_MS);
    }
  }

  openList() {
    if (!this.canZap) return;
    this.listChannels = this.channels;
    this.listGroupName = this.channel.group ?? this.listGroupName;
    this.listIndex = Math.max(0, this.currentIndex);
    this.overlay = "list";
    this.bannerVisible = false;
    this.poke();
    setTimeout(() => this.scrollTo(`list-${this.listIndex}`));
  }

  async openGroups(returnTo: "list" | "guide") {
    this.groupsReturn = returnTo;
    this.overlay = "groups";
    this.poke();
    await this.loadGroups();
    const i = this.groups.findIndex((g) => g.id === this.channel.group_id);
    this.groupIndex = Math.max(0, i);
    setTimeout(() => this.scrollTo(`group-${this.groupIndex}`));
  }

  openGuide() {
    if (!this.canZap) return;
    this.listChannels = this.channels;
    this.overlay = "guide";
    this.bannerVisible = false;
    this.poke();
  }

  openSettings() {
    this.overlay = "settings";
    this.settingsPage = "main";
    this.menuIndex = 0;
    this.bannerVisible = false;
  }

  closeOverlay() {
    this.overlay = "none";
    clearTimeout(this.overlayTimer);
  }

  async pickGroup(i: number) {
    const group = this.groups[i];
    if (!group) return;
    this.listGroupName = group.name ?? "";
    this.listChannels = [];
    this.overlay = this.groupsReturn;
    this.listIndex = 0;
    await this.fetchGroup(group.id, (all) => (this.listChannels = all));
  }

  private scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ block: "center" });
  }

  // ---------- settings menu ----------

  get menuTitle(): string {
    return {
      main: "Settings",
      audio: "Audio track",
      sub: "Subtitles",
      video: "Video track",
      aspect: "Aspect ratio",
      speed: "Playback speed",
      sleep: "Sleep timer",
    }[this.settingsPage];
  }

  get menuItems(): MenuItem[] {
    const page = (p: SettingsPage) => () => {
      this.settingsPage = p;
      this.menuIndex = 0;
    };
    const trackItems = (type: Track["type"]): MenuItem[] => [
      ...(type === "sub"
        ? [{ label: "Off", checked: !this.selected("sub"), action: () => this.selectTrack("sub", "no") }]
        : []),
      ...this.tracksOf(type).map((t) => ({
        label: this.trackLabel(t),
        checked: t.selected,
        action: () => this.selectTrack(type, t.id),
      })),
    ];
    switch (this.settingsPage) {
      case "audio":
        return trackItems("audio");
      case "sub":
        return trackItems("sub");
      case "video":
        return trackItems("video");
      case "aspect":
        return ASPECTS.map((a, i) => ({ label: a.label, checked: i === this.aspect, action: () => this.setAspect(i) }));
      case "speed":
        return SPEEDS.map((s) => ({
          label: s === 1 ? "Normal" : `${s}x`,
          checked: this.p["speed"] == s,
          action: () => this.set("speed", s),
        }));
      case "sleep":
        return SLEEP_MINUTES.map((m) => ({
          label: m ? `${m} minutes` : "Off",
          checked: m ? false : !this.sleepAt,
          action: () => this.setSleep(m),
        }));
    }
    const items: MenuItem[] = [];
    if (this.canZap)
      items.push({
        label: this.channel.favorite ? "Remove from favorites" : "Add to favorites",
        action: () => this.toggleFavorite(),
      });
    if (this.tracksOf("audio").length > 1)
      items.push({ label: "Audio track", value: this.trackLabel(this.selected("audio")), submenu: true, action: page("audio") });
    if (this.tracksOf("sub").length)
      items.push({ label: "Subtitles", value: this.trackLabel(this.selected("sub")), submenu: true, action: page("sub") });
    if (this.tracksOf("video").length > 1)
      items.push({ label: "Video track", value: this.trackLabel(this.selected("video")), submenu: true, action: page("video") });
    items.push({ label: "Aspect ratio", value: ASPECTS[this.aspect].label, submenu: true, action: page("aspect") });
    if (!this.live)
      items.push({
        label: "Playback speed",
        value: this.p["speed"] == 1 ? "Normal" : `${this.p["speed"]}x`,
        submenu: true,
        action: page("speed"),
      });
    items.push({ label: "Sleep timer", value: this.sleepLabel, submenu: true, action: page("sleep") });
    if (!this.live) items.push({ label: "Loop", checked: this.looping, action: () => this.toggleLoop() });
    items.push({ label: "Stats for nerds", checked: this.stats, action: () => (this.stats = !this.stats) });
    items.push({ label: "Copy stream URL", action: () => this.copyUrl() });
    items.push({ label: "Stop playback", action: () => this.stop() });
    return items;
  }

  activateMenu(i: number) {
    const item = this.menuItems[i];
    if (!item) return;
    item.action();
    if (!item.submenu && this.settingsPage !== "main") {
      this.settingsPage = "main";
      this.menuIndex = 0;
    }
  }

  selectTrack(type: Track["type"], id: number | "no") {
    this.set({ video: "vid", audio: "aid", sub: "sid" }[type], id);
  }

  setAspect(i: number) {
    this.aspect = i;
    Object.entries(ASPECTS[i].props).forEach(([k, v]) => this.set(k, v));
  }

  get sleepLabel(): string {
    if (!this.sleepAt) return "Off";
    return `${Math.max(1, Math.round((this.sleepAt - Date.now()) / 60000))} min`;
  }

  setSleep(minutes: number) {
    clearTimeout(this.sleepTimer);
    this.sleepAt = minutes ? Date.now() + minutes * 60000 : undefined;
    if (minutes) this.sleepTimer = window.setTimeout(() => this.set("pause", true), minutes * 60000);
  }

  get looping(): boolean {
    return this.p["loop-file"] === "inf" || this.p["loop-file"] === true;
  }

  toggleLoop() {
    this.set("loop-file", this.looping ? "no" : "inf");
  }

  async toggleFavorite() {
    const fav = !this.channel.favorite;
    try {
      await invoke(fav ? "favorite_channel" : "unfavorite_channel", { channelId: this.channel.id });
      this.channel.favorite = fav;
      this.flashHint(fav ? "Added to favorites" : "Removed from favorites");
    } catch (e) {
      console.error(e);
    }
  }

  async copyUrl() {
    if (this.p["path"]) await writeText(this.p["path"]);
    this.flashHint("Stream URL copied");
  }

  // ---------- playback ----------

  togglePause() {
    if (this.ended) return this.replay();
    this.set("pause", !this.paused);
    this.pauseFlash = Date.now();
    this.showBanner();
  }

  replay() {
    this.cmd("seek", 0, "absolute");
    this.set("pause", false);
  }

  seekBy(seconds: number) {
    this.cmd("seek", seconds, "relative");
    this.flashHint(`${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`);
    this.showBanner();
  }

  seekFraction(f: number, exact = true) {
    this.cmd("seek", f * this.duration, exact ? "absolute" : "absolute+keyframes");
  }

  changeVolume(delta: number) {
    const v = Math.max(0, Math.min(100, Math.round((this.p["volume"] ?? 100) + delta)));
    this.setVolume(v);
    this.flashHint(`Volume ${v}%`);
  }

  setVolume(v: number) {
    this.set("volume", v);
    if (v > 0 && this.p["mute"]) this.set("mute", false);
    this.saveVolume();
  }

  toggleMute() {
    this.set("mute", !this.muted);
    if (this.p["volume"] == 0) this.set("volume", 50);
    this.flashHint(this.muted ? `Volume ${this.p["volume"]}%` : "Muted");
  }

  // Remember volume across sessions via the app's existing volume setting.
  private saveVolume() {
    clearTimeout(this.saveVolumeTimer);
    this.saveVolumeTimer = window.setTimeout(async () => {
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
      this.flashHint("Subtitles off");
    } else {
      const subs = this.tracksOf("sub");
      if (!subs.length) return;
      this.set("sid", this.lastSubId ?? subs[0].id);
      this.flashHint("Subtitles on");
    }
  }

  private flashHint(text: string) {
    clearTimeout(this.volumeHintTimer);
    this.volumeHint = text;
    this.volumeHintTimer = window.setTimeout(() => (this.volumeHint = undefined), 1200);
  }

  // ---------- window ----------

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
      this.normalSize = (await win.innerSize()).toLogical(await win.scaleFactor());
      await win.setSize(new LogicalSize(480, 270));
    } else if (this.normalSize) {
      await win.setSize(this.normalSize);
    }
    await win.setAlwaysOnTop(this.mini);
  }

  /** TiviMate's Back: keep playing in the preview box and return to browsing. */
  async backToBrowse() {
    this.closeOverlay();
    if (this.fullscreen) await this.toggleFullscreen();
    if (this.mini) await this.toggleMini();
    this.player.setMode("preview");
  }

  stop() {
    this.player.stop();
  }

  // ---------- mouse ----------

  @HostListener("document:mousemove")
  onMouseMove() {
    if (!this.player.full) return;
    this.poke();
    if (this.overlay === "none") this.showBanner();
  }

  onSurfaceClick() {
    if (this.overlay !== "none") return this.closeOverlay();
    if (this.live) {
      if (this.bannerVisible) this.bannerVisible = false;
      else this.showBanner();
    } else this.togglePause();
  }

  onContextMenu(e: MouseEvent) {
    e.preventDefault();
    this.openSettings();
  }

  @HostListener("document:wheel", ["$event"])
  onWheel(e: WheelEvent) {
    if (!this.player.full || this.overlay !== "none") return;
    this.changeVolume(e.deltaY < 0 ? 5 : -5);
  }

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
        this.showBanner();
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      });
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---------- keyboard: TiviMate remote mapping ----------

  @HostListener("document:keydown", ["$event"])
  onKeyDown(e: KeyboardEvent) {
    if (!this.player.full || e.ctrlKey || e.altKey || e.metaKey) return;
    this.poke();
    let handled: boolean;
    switch (this.overlay) {
      case "list":
        handled = this.listKey(e, this.listChannels.length);
        break;
      case "groups":
        handled = this.listKey(e, this.groups.length);
        break;
      case "guide":
        handled = this.guideKey(e);
        break;
      case "settings":
        handled = this.settingsKey(e);
        break;
      default:
        handled = this.watchKey(e);
    }
    if (handled) e.preventDefault();
  }

  @HostListener("document:keyup", ["$event"])
  onKeyUp(e: KeyboardEvent) {
    if (!this.player.full || e.key !== "Enter" || this.longPress === undefined) return;
    clearTimeout(this.longPress);
    this.longPress = undefined;
    if (this.longPressFired) return;
    // Short OK: channel list on live TV, play/pause on VOD.
    if (this.live && this.canZap) this.openList();
    else this.togglePause();
  }

  private watchKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "Enter":
        if (!e.repeat) {
          this.longPressFired = false;
          this.longPress = window.setTimeout(() => {
            this.longPressFired = true;
            this.openSettings();
          }, LONG_PRESS_MS);
        }
        return true;
      case "ArrowUp":
      case "PageUp":
        if (this.canZap && !this.catchup) this.zapBy(-1);
        else this.changeVolume(5);
        return true;
      case "ArrowDown":
      case "PageDown":
        if (this.canZap && !this.catchup) this.zapBy(1);
        else this.changeVolume(-5);
        return true;
      case "ArrowLeft":
        if (this.hasTimeline) this.seekBy(-10);
        else this.openGuide();
        return true;
      case "ArrowRight":
        if (this.hasTimeline) this.seekBy(10);
        else this.showBanner();
        return true;
      case "Backspace":
        if (this.prevChannel) this.tune(this.prevChannel);
        return true;
      case "Escape":
        if (this.fullscreen) this.toggleFullscreen();
        else if (this.mini) this.toggleMini();
        else this.backToBrowse();
        return true;
      case " ":
      case "k":
        this.togglePause();
        return true;
      case "ContextMenu":
      case "s":
        this.openSettings();
        return true;
      case "g":
        this.openGuide();
        return true;
      case "i":
        this.showBanner();
        return true;
      case "m":
        this.toggleMute();
        return true;
      case "f":
        this.toggleFullscreen();
        return true;
      case "c":
        this.toggleCaptions();
        return true;
      case "p":
        this.toggleMini();
        return true;
      case "+":
      case "=":
        this.changeVolume(5);
        return true;
      case "-":
        this.changeVolume(-5);
        return true;
      case "N":
        if (this.hasNextEpisode) this.cmd("playlist-next");
        return true;
    }
    if (/^[0-9]$/.test(e.key) && this.canZap) {
      this.typeNumber(e.key);
      return true;
    }
    return false;
  }

  /** Shared navigation for the channel list and group list panels. */
  private listKey(e: KeyboardEvent, length: number): boolean {
    const isList = this.overlay === "list";
    const index = isList ? this.listIndex : this.groupIndex;
    const move = (i: number) => {
      const next = Math.max(0, Math.min(length - 1, i));
      if (isList) this.listIndex = next;
      else this.groupIndex = next;
      this.scrollTo(`${isList ? "list" : "group"}-${next}`);
    };
    switch (e.key) {
      case "ArrowUp":
        move(index - 1);
        return true;
      case "ArrowDown":
        move(index + 1);
        return true;
      case "PageUp":
        move(index - 10);
        return true;
      case "PageDown":
        move(index + 10);
        return true;
      case "Home":
        move(0);
        return true;
      case "End":
        move(length - 1);
        return true;
      case "Enter":
        if (isList) {
          this.tune(this.listChannels[this.listIndex], this.listChannels);
          this.closeOverlay();
        } else this.pickGroup(this.groupIndex);
        return true;
      case "ArrowLeft":
        if (isList) this.openGroups("list");
        return true;
      case "ArrowRight":
        if (!isList) this.overlay = this.groupsReturn;
        else this.closeOverlay();
        return true;
      case "Escape":
      case "Backspace":
        if (!isList) this.overlay = this.groupsReturn;
        else this.closeOverlay();
        return true;
    }
    return false;
  }

  private guideKey(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Backspace") {
      this.closeOverlay();
      return true;
    }
    return this.grid?.handleKey(e) ?? false;
  }

  private settingsKey(e: KeyboardEvent): boolean {
    const items = this.menuItems;
    switch (e.key) {
      case "ArrowUp":
        this.menuIndex = Math.max(0, this.menuIndex - 1);
        return true;
      case "ArrowDown":
        this.menuIndex = Math.min(items.length - 1, this.menuIndex + 1);
        return true;
      case "Enter":
      case "ArrowRight":
        this.activateMenu(this.menuIndex);
        return true;
      case "ArrowLeft":
      case "Backspace":
        if (this.settingsPage !== "main") {
          this.settingsPage = "main";
          this.menuIndex = 0;
        } else this.closeOverlay();
        return true;
      case "Escape":
        this.closeOverlay();
        return true;
    }
    return false;
  }

  private typeNumber(digit: string) {
    this.typed = (this.typed + digit).slice(-4);
    clearTimeout(this.numberTimer);
    this.numberTimer = window.setTimeout(() => {
      const n = +this.typed;
      this.typed = "";
      if (n > 0 && n <= this.channels.length) this.tune(this.channels[n - 1]);
    }, NUMBER_ENTRY_MS);
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
