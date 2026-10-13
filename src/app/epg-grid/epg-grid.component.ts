import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { Subscription } from "rxjs";
import { EpgService, Programme, clockTime } from "../epg.service";
import { ErrorService } from "../error.service";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";

const HALF_HOUR = 30 * 60_000;
const floorHalfHour = (t: number) => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/**
 * TiviMate-style guide: channels down the side, programmes laid out on a time axis.
 * Keyboard is routed in by the host via handleKey() so the host decides who owns the arrows.
 */
@Component({
  selector: "app-epg-grid",
  templateUrl: "./epg-grid.component.html",
  styleUrl: "./epg-grid.component.css",
})
export class EpgGridComponent implements OnInit, OnChanges, OnDestroy {
  @Input() channels: Channel[] = [];
  @Input() spanMinutes = 180;
  /** Channel currently playing (player overlay highlights it). */
  @Input() currentId?: number;
  @Output() play = new EventEmitter<Channel>();
  @Output() playArchive = new EventEmitter<{ channel: Channel; programme: Programme }>();
  @Output() exitLeft = new EventEmitter<void>();
  @Output() nearEnd = new EventEmitter<void>();

  programmes = new Map<number, Programme[]>();
  loaded = new Set<number>();
  row = 0;
  focused?: Programme;
  now = Date.now();
  windowStart = floorHalfHour(Date.now());
  private cursor = Date.now();
  private sub?: Subscription;

  constructor(
    private epg: EpgService,
    public memory: MemoryService,
    private error: ErrorService,
  ) {}

  ngOnInit() {
    this.memory.get_epg_ids().catch(console.error);
    this.sub = this.epg.clock$.subscribe((t) => (this.now = t));
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes["channels"] && !changes["channels"].firstChange) {
      const prev: Channel[] = changes["channels"].previousValue ?? [];
      // A new list (not "load more"): start from the top.
      if (prev[0]?.id !== this.channels[0]?.id) this.focusRow(0);
    }
    if (changes["currentId"] && this.currentId != null) {
      const i = this.channels.findIndex((c) => c.id === this.currentId);
      if (i >= 0) this.focusRow(i);
    }
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  // ---------- data ----------

  async load(channel: Channel) {
    if (channel.id == null) return;
    const list = await this.epg.get(channel);
    this.programmes.set(channel.id, list);
    this.loaded.add(channel.id);
    if (this.channels[this.row]?.id === channel.id && !this.focused) this.pickAtCursor();
  }

  get windowEnd(): number {
    return this.windowStart + this.spanMinutes * 60_000;
  }

  get ticks(): number[] {
    return Array.from({ length: this.spanMinutes / 30 }, (_, i) => this.windowStart + i * HALF_HOUR);
  }

  visible(channel: Channel): Programme[] {
    return (this.programmes.get(channel.id!) ?? []).filter(
      (p) => p.end > this.windowStart && p.start < this.windowEnd,
    );
  }

  pct(t: number): number {
    return ((t - this.windowStart) / (this.windowEnd - this.windowStart)) * 100;
  }

  left(p: Programme): number {
    return this.pct(Math.max(p.start, this.windowStart));
  }

  width(p: Programme): number {
    return this.pct(Math.min(p.end, this.windowEnd)) - this.left(p);
  }

  isNow(p: Programme): boolean {
    return p.start <= this.now && this.now < p.end;
  }

  hasReminder(p: Programme): boolean {
    return this.memory.Watched_epgs.has(p.epg_id);
  }

  time = clockTime;

  trackProgramme(_: number, p: Programme) {
    return p.epg_id;
  }

  get focusedChannel(): Channel | undefined {
    return this.channels[this.row];
  }

  get focusedProgress(): number {
    return this.focused ? this.epg.progress(this.focused, this.now) : 0;
  }

  // ---------- navigation ----------

  handleKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowUp":
        this.focusRow(this.row - 1);
        break;
      case "ArrowDown":
        this.focusRow(this.row + 1);
        break;
      case "PageUp":
        this.focusRow(this.row - 8);
        break;
      case "PageDown":
        this.focusRow(this.row + 8);
        break;
      case "ArrowLeft":
        this.step(-1);
        break;
      case "ArrowRight":
        this.step(1);
        break;
      case "Enter":
        this.activate();
        break;
      default:
        return false;
    }
    return true;
  }

  focusRow(i: number) {
    if (!this.channels.length) return;
    this.row = Math.max(0, Math.min(this.channels.length - 1, i));
    this.pickAtCursor();
    document.getElementById(`grid-row-${this.row}`)?.scrollIntoView({ block: "nearest" });
    if (this.row >= this.channels.length - 6) this.nearEnd.emit();
  }

  /** Keep the time cursor when changing rows, like a real guide. */
  private pickAtCursor() {
    const list = this.programmes.get(this.focusedChannel?.id!) ?? [];
    this.focused =
      list.find((p) => p.start <= this.cursor && this.cursor < p.end) ??
      list.find((p) => p.start > this.cursor);
  }

  private step(dir: number) {
    const list = this.programmes.get(this.focusedChannel?.id!) ?? [];
    const i = this.focused ? list.indexOf(this.focused) : -1;
    const target = list[i + dir];
    if (!target || (dir < 0 && i < 0)) {
      if (dir < 0) this.exitLeft.emit();
      return;
    }
    this.focused = target;
    this.cursor = Math.max(target.start, Math.min(this.now, target.end - 1));
    if (target.start < this.windowStart || target.start >= this.windowEnd - HALF_HOUR) {
      this.windowStart = floorHalfHour(dir > 0 ? target.start - HALF_HOUR : target.start);
    }
  }

  shiftWindow(minutes: number) {
    this.windowStart = minutes ? this.windowStart + minutes * 60_000 : floorHalfHour(Date.now());
    this.cursor = minutes ? Math.max(this.windowStart, this.cursor) : Date.now();
    this.pickAtCursor();
  }

  // ---------- actions ----------

  onProgrammeClick(rowIndex: number, p: Programme) {
    if (this.row === rowIndex && this.focused === p) return this.activate();
    this.row = rowIndex;
    this.focused = p;
    this.cursor = Math.max(p.start, Math.min(this.now, p.end - 1));
  }

  onChannelClick(rowIndex: number) {
    this.row = rowIndex;
    this.play.emit(this.channels[rowIndex]);
  }

  activate() {
    const channel = this.focusedChannel;
    if (!channel) return;
    const p = this.focused;
    if (!p || this.isNow(p)) this.play.emit(channel);
    else if (p.end <= this.now && p.timeshift_url) this.playArchive.emit({ channel, programme: p });
    else if (p.start > this.now) this.toggleReminder(channel, p);
  }

  private async toggleReminder(channel: Channel, p: Programme) {
    if (!this.memory.trayEnabled) {
      this.error.info("Enable the tray icon in settings to get programme reminders");
      return;
    }
    try {
      if (this.hasReminder(p)) {
        await invoke("remove_epg", { epgId: p.epg_id });
        this.error.success(`Reminder removed: ${p.title}`);
      } else {
        await invoke("add_epg", {
          epg: {
            channel_name: channel.name,
            epg_id: p.epg_id,
            start_timestamp: p.start_timestamp,
            title: p.title,
          },
        });
        this.error.success(`Reminder set: ${p.title} at ${clockTime(p.start)}`);
      }
      await this.memory.get_epg_ids();
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
