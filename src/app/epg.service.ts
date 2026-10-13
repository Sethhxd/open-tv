import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { interval, map, share, startWith } from "rxjs";
import { Channel } from "./models/channel";
import { EPG } from "./models/epg";
import { MediaType } from "./models/mediaType";

/** An EPG entry with absolute start/end in ms. */
export interface Programme extends EPG {
  start: number;
  end: number;
}

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

// Xtream returns a channel's whole guide per call; keep the provider happy.
const MAX_PARALLEL = 4;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Lazy, cached access to Xtream EPG (the only EPG the backend exposes), one channel at a time.
 * ponytail: in-memory cache for the window's lifetime; persist it if startup refetching hurts.
 */
@Injectable({ providedIn: "root" })
export class EpgService {
  private cache = new Map<number, Promise<Programme[]>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  /** Emits Date.now() every 30s so progress bars and "now" stay current. */
  readonly clock$ = interval(30_000).pipe(
    startWith(0),
    map(() => Date.now()),
    share(),
  );

  hasEpg(channel?: Channel): boolean {
    return (
      channel?.media_type === MediaType.livestream && channel.stream_id != null && channel.id != null
    );
  }

  get(channel?: Channel): Promise<Programme[]> {
    if (!channel || !this.hasEpg(channel)) return Promise.resolve([]);
    let programmes = this.cache.get(channel.id!);
    if (!programmes) {
      programmes = this.fetch(channel);
      this.cache.set(channel.id!, programmes);
    }
    return programmes;
  }

  nowNext(programmes: Programme[], t = Date.now()): NowNext {
    const i = programmes.findIndex((p) => p.start <= t && t < p.end);
    if (i >= 0) return { now: programmes[i], next: programmes[i + 1] };
    return { next: programmes.find((p) => p.start > t) };
  }

  progress(p?: Programme, t = Date.now()): number {
    if (!p) return 0;
    return Math.max(0, Math.min(1, (t - p.start) / (p.end - p.start)));
  }

  private async fetch(channel: Channel): Promise<Programme[]> {
    await this.acquire();
    try {
      const list: EPG[] = await invoke("get_epg", { channel });
      return toProgrammes(list);
    } catch (e) {
      console.error(e);
      return [];
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_PARALLEL) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release() {
    // LIFO: the rows the user just scrolled to are the ones they're looking at.
    const next = this.waiting.pop();
    if (next) next();
    else this.active--;
  }
}

export function toProgrammes(list: EPG[]): Programme[] {
  const sorted = [...list].sort((a, b) => a.start_timestamp - b.start_timestamp);
  return sorted.map((e, i) => {
    const start = e.start_timestamp * 1000;
    const next = sorted[i + 1];
    const end = parseEnd(e.end_time, start) ?? (next ? next.start_timestamp * 1000 : start + 3_600_000);
    return { ...e, start, end };
  });
}

/** Backend formats end times as "%B %d, %H:%M" in local time, without a year. */
export function parseEnd(text: string, start: number): number | undefined {
  const m = /^(\w+) (\d+), (\d+):(\d+)$/.exec(text?.trim() ?? "");
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return undefined;
  const year = new Date(start).getFullYear();
  let end = new Date(year, month, +m[2], +m[3], +m[4]).getTime();
  if (end < start) end = new Date(year + 1, month, +m[2], +m[3], +m[4]).getTime(); // Dec 31 -> Jan 1
  return end;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
