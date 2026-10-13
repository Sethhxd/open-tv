import { EpgService, parseEnd, toProgrammes } from "./epg.service";
import { EPG } from "./models/epg";

const epg = (start: Date, end_time: string, title = "x"): EPG => ({
  epg_id: title,
  title,
  description: "",
  start_time: "",
  start_timestamp: start.getTime() / 1000,
  end_time,
  has_archive: false,
  now_playing: false,
});

describe("EPG parsing", () => {
  it("parses the backend's local end time", () => {
    const start = new Date(2026, 9, 13, 20, 0).getTime();
    expect(parseEnd("October 13, 22:30", start)).toBe(new Date(2026, 9, 13, 22, 30).getTime());
  });

  it("rolls the year over for programmes crossing New Year", () => {
    const start = new Date(2026, 11, 31, 23, 0).getTime();
    expect(parseEnd("January 01, 01:00", start)).toBe(new Date(2027, 0, 1, 1, 0).getTime());
  });

  it("falls back to the next programme's start when the end is unparseable", () => {
    const a = new Date(2026, 9, 13, 20, 0);
    const b = new Date(2026, 9, 13, 21, 0);
    const [first] = toProgrammes([epg(b, "October 13, 22:00", "b"), epg(a, "garbage", "a")]);
    expect(first.title).toBe("a");
    expect(first.end).toBe(b.getTime());
  });

  it("finds now/next and ignores gaps", () => {
    const service = new EpgService();
    const list = toProgrammes([
      epg(new Date(2026, 9, 13, 20, 0), "October 13, 21:00", "now"),
      epg(new Date(2026, 9, 13, 22, 0), "October 13, 23:00", "later"),
    ]);
    const at = (h: number, m: number) => new Date(2026, 9, 13, h, m).getTime();
    expect(service.nowNext(list, at(20, 30)).now?.title).toBe("now");
    expect(service.nowNext(list, at(20, 30)).next?.title).toBe("later");
    expect(service.nowNext(list, at(21, 30)).now).toBeUndefined();
    expect(service.nowNext(list, at(21, 30)).next?.title).toBe("later");
    expect(service.progress(list[0], at(20, 15))).toBeCloseTo(0.25);
  });
});
