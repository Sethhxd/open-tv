import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
} from "@angular/core";
import { Router } from "@angular/router";
import { Subscription, debounceTime, fromEvent, map, skip } from "rxjs";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { ViewMode } from "../models/viewMode";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { invoke } from "@tauri-apps/api/core";
import { Source } from "../models/source";
import { Filters } from "../models/filters";
import { SourceType } from "../models/sourceType";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SortType } from "../models/sortType";
import { getVersion } from "@tauri-apps/api/app";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { WhatsNewModalComponent } from "../whats-new-modal/whats-new-modal.component";
import { LAST_SEEN_VERSION } from "../models/localStorage";
import { Node } from "../models/node";
import { NodeType } from "../models/nodeType";
import { Stack } from "../models/stack";
import { BulkActionType } from "../models/bulkActionType";
import { ChannelTileComponent } from "../channel-tile/channel-tile.component";
import { EpgGridComponent } from "../epg-grid/epg-grid.component";
import { EpgService, NowNext, Programme, clockTime } from "../epg.service";
import { ICONS } from "../player/icons";
import { PlayerService } from "../player.service";

type SectionId = "tv" | "guide" | "movies" | "series" | "favorites" | "history" | "hidden";
type Zone = "rail" | "groups" | "items";

interface Section {
  id: SectionId;
  label: string;
  icon: string;
  media: MediaType[];
  view: ViewMode;
  /** Sections with a groups column (TiviMate's category list). */
  groups: boolean;
}

/** Pseudo groups pinned above the provider's categories, like TiviMate. */
interface GroupEntry {
  name: string;
  kind: "recent" | "fav" | "all" | "group";
  id?: number;
}

const ALL_MEDIA = [MediaType.livestream, MediaType.movie, MediaType.serie];
const PAGE_SIZE = 36; // backend page size
const LONG_PRESS_MS = 600;
const GROUP_SETTLE_MS = 300;

@Component({
  selector: "app-home",
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.css",
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  readonly icons = ICONS;
  readonly bulkActionType = BulkActionType;
  readonly viewModeEnum = ViewMode;
  @ViewChild("search") search!: ElementRef<HTMLInputElement>;
  @ViewChild("itemList") itemList?: ElementRef<HTMLElement>;
  @ViewChildren(ChannelTileComponent) tiles!: QueryList<ChannelTileComponent>;
  @ViewChild(EpgGridComponent) grid?: EpgGridComponent;

  /** TiviMate keeps the stream running in a small preview while you browse. */
  @ViewChild("preview") set preview(el: ElementRef<HTMLElement> | undefined) {
    // Deferred: ViewChild setters run during change detection.
    setTimeout(() => this.player.setPreviewElement(el?.nativeElement));
  }

  sections: Section[] = [];
  section?: Section;
  groups: GroupEntry[] = [];
  selectedGroup?: GroupEntry;
  items: Channel[] = [];
  filters?: Filters;
  nodeStack = new Stack();

  zone: Zone = "items";
  railIndex = 0;
  groupIndex = 0;
  itemIndex = 0;

  loading = false;
  reachedMax = false;
  private groupsPage = 1;
  private groupsReachedMax = false;
  private groupsLoading = false;

  info?: Channel;
  infoNowNext: NowNext = {};
  infoUpcoming: Programme[] = [];
  now = Date.now();
  time = clockTime;

  private subscriptions: Subscription[] = [];
  private groupSettle?: number;
  private longPress?: number;
  private longPressFired = false;
  private numberEntry = "";
  private numberTimer?: number;
  private infoSeq = 0;

  constructor(
    private router: Router,
    public memory: MemoryService,
    public toast: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    public epg: EpgService,
    public player: PlayerService,
  ) {
    this.getSources();
  }

  // ---------- startup (unchanged behaviour from the original home screen) ----------

  getSources() {
    Promise.all([invoke("get_settings"), invoke("get_sources")])
      .then(([settingsData, sourcesData]) => {
        const settings = settingsData as Settings;
        const sources = sourcesData as Source[];
        if (settings.zoom) getCurrentWebview().setZoom(Math.trunc(settings.zoom! * 100) / 10000);
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map((s) => [s.id!, s]));
        if (sources.length == 0) return this.reset();
        getVersion().then((version) => {
          if (localStorage.getItem(LAST_SEEN_VERSION) != version) {
            this.memory.AppVersion = version;
            this.memory.ModalRef = this.modal.open(WhatsNewModalComponent, {
              backdrop: "static",
              size: "xl",
              keyboard: false,
            });
            this.memory.ModalRef.componentInstance.name = "WhatsNewModal";
          }
        });
        sources
          .filter((x) => x.source_type == SourceType.Custom)
          .forEach((x) => this.memory.CustomSourceIds?.add(x.id!));
        sources
          .filter((x) => x.source_type == SourceType.Xtream)
          .forEach((x) => this.memory.XtreamSourceIds.add(x.id!));
        if (this.memory.XtreamSourceIds.size > 0 && !sessionStorage.getItem("epgCheckedOnStart")) {
          sessionStorage.setItem("epgCheckedOnStart", "true");
          invoke("on_start_check_epg");
        }
        this.filters = {
          source_ids: Array.from(this.memory.Sources.keys()),
          view_type: ViewMode.All,
          media_types: [MediaType.livestream],
          page: 1,
          use_keywords: false,
          sort: SortType.provider,
        };
        if (settings.default_sort != undefined && settings.default_sort != SortType.provider) {
          this.memory.Sort.next([settings.default_sort, false]);
          this.filters.sort = settings.default_sort;
        }
        this.sections = this.buildSections();
        if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
          sessionStorage.setItem("refreshedOnStart", "true");
          this.refreshOnStart();
        }
        const start: SectionId =
          settings.default_view == ViewMode.Favorites
            ? "favorites"
            : settings.default_view == ViewMode.History
              ? "history"
              : settings.default_view == ViewMode.Hidden
                ? "hidden"
                : "tv";
        this.selectSection(this.sections.find((s) => s.id === start)!, true);
      })
      .catch((e) => {
        this.error.handleError(e);
        this.reset();
      });
  }

  private buildSections(): Section[] {
    const xtream = this.anyXtream();
    const all: Section[] = [
      { id: "tv", label: "TV", icon: ICONS.tv, media: [MediaType.livestream], view: ViewMode.All, groups: true },
      { id: "guide", label: "Guide", icon: ICONS.guide, media: [MediaType.livestream], view: ViewMode.All, groups: true },
      {
        id: "movies",
        label: xtream ? "Movies" : "Movies & Series",
        icon: ICONS.movies,
        media: [MediaType.movie],
        view: ViewMode.All,
        groups: true,
      },
      { id: "series", label: "Series", icon: ICONS.series, media: [MediaType.serie], view: ViewMode.All, groups: true },
      { id: "favorites", label: "Favorites", icon: ICONS.star, media: ALL_MEDIA, view: ViewMode.Favorites, groups: false },
      { id: "history", label: "History", icon: ICONS.history, media: ALL_MEDIA, view: ViewMode.History, groups: false },
      { id: "hidden", label: "Hidden", icon: ICONS.hidden, media: ALL_MEDIA, view: ViewMode.Hidden, groups: false },
    ];
    return all.filter((s) => s.id !== "series" || xtream);
  }

  async refreshOnStart() {
    this.toast.info("Refreshing all sources... (refresh on start enabled)");
    await this.memory.tryIPC(
      "Successfully refreshed all sources (refresh on start enabled)",
      "Failed to refresh all sources (refresh on start enabled)",
      () => invoke("refresh_all"),
    );
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  openSettings() {
    this.router.navigateByUrl("settings");
  }

  anyXtream() {
    return Array.from(this.memory.Sources.values()).some((x) => x.source_type == SourceType.Xtream);
  }

  ngAfterViewInit(): void {
    this.subscriptions.push(
      fromEvent<KeyboardEvent>(this.search.nativeElement, "input")
        .pipe(
          map((e) => (e.target as HTMLInputElement).value),
          debounceTime(300),
        )
        .subscribe(async (term) => {
          if (!this.filters) return;
          this.filters.query = term;
          await this.load();
        }),
      this.memory.SetNode.subscribe((dto) => this.openNode(dto.id, dto.name, dto.type, dto.sourceId)),
      this.memory.Refresh.subscribe(() => this.load()),
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters.sort = sort;
        await Promise.all([this.load(), this.loadGroups()]);
      }),
      this.epg.clock$.subscribe((t) => (this.now = t)),
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }

  // ---------- sections & groups ----------

  get isGuide(): boolean {
    return this.section?.id === "guide";
  }

  get showGroups(): boolean {
    return !!this.section?.groups && !this.nodeStack.hasNodes();
  }

  get title(): string {
    if (this.nodeStack.hasNodes()) return this.nodeStack.get()!.name;
    if (this.section?.groups) return this.selectedGroup?.name ?? this.section.label;
    return this.section?.label ?? "";
  }

  async selectSection(section: Section, startup = false) {
    if (!this.filters) return;
    this.section = section;
    this.railIndex = this.sections.indexOf(section);
    this.nodeStack.clear();
    this.filters.series_id = this.filters.season = undefined;
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.clearSearch();
    this.groups = [];
    this.selectedGroup = undefined;
    if (section.groups) {
      // TiviMate opens on what you watched last.
      const live = section.media.includes(MediaType.livestream);
      this.selectedGroup = live || startup ? this.pseudoGroups()[0] : this.pseudoGroups()[1];
      this.groupIndex = this.pseudoGroups().indexOf(this.selectedGroup);
      await this.loadGroups();
    }
    this.applyFilters();
    await this.load();
    // Nothing watched yet: fall back to all channels.
    if (startup && this.selectedGroup?.kind === "recent" && !this.items.length) {
      await this.selectGroup(this.groups.findIndex((g) => g.kind === "all"));
    }
    if (startup) this.focusZone("items");
    else if (this.zone === "groups") this.focusGroup(this.groupIndex);
  }

  private pseudoGroups(): GroupEntry[] {
    const live = this.section?.media.includes(MediaType.livestream);
    return [
      { name: live ? "Recent" : "Continue watching", kind: "recent" },
      { name: live ? "All channels" : "All", kind: "all" },
      { name: "Favorites", kind: "fav" },
    ];
  }

  async loadGroups(more = false) {
    if (!this.filters || !this.section?.groups || this.groupsLoading) return;
    this.groupsLoading = true;
    this.groupsPage = more ? this.groupsPage + 1 : 1;
    try {
      const groups: Channel[] = await invoke("search", {
        filters: {
          ...this.filters,
          view_type: ViewMode.Categories,
          media_types: this.section.media,
          page: this.groupsPage,
          query: "",
          group_id: undefined,
          series_id: undefined,
          season: undefined,
        },
      });
      const entries = groups.map((g): GroupEntry => ({ name: g.name!, kind: "group", id: g.id }));
      this.groups = more ? this.groups.concat(entries) : [...this.pseudoGroups(), ...entries];
      if (!more && this.selectedGroup) {
        this.selectedGroup = this.groups.find(
          (g) => g.kind === this.selectedGroup!.kind && g.id === this.selectedGroup!.id,
        );
      }
      this.groupsReachedMax = groups.length < PAGE_SIZE;
    } catch (e) {
      this.error.handleError(e);
    }
    this.groupsLoading = false;
  }

  async selectGroup(index: number) {
    const group = this.groups[index];
    if (!group || !this.filters) return;
    this.groupIndex = index;
    if (group === this.selectedGroup && !this.nodeStack.hasNodes()) return;
    this.selectedGroup = group;
    this.nodeStack.clear();
    this.filters.series_id = this.filters.season = undefined;
    this.filters.source_ids = Array.from(this.memory.Sources.keys());
    this.clearSearch();
    this.applyFilters();
    await this.load();
  }

  /** Maps section + group onto the backend's search filters. */
  private applyFilters() {
    const f = this.filters!;
    const s = this.section!;
    f.media_types = [...s.media];
    f.view_type = s.view;
    f.group_id = undefined;
    const g = this.selectedGroup;
    if (s.groups && g) {
      if (g.kind === "recent") f.view_type = ViewMode.History;
      else if (g.kind === "fav") f.view_type = ViewMode.Favorites;
      else if (g.kind === "group") f.group_id = g.id;
    }
  }

  // ---------- items ----------

  async load(more = false) {
    if (!this.filters) return;
    this.loading = true;
    this.filters.page = more ? this.filters.page + 1 : 1;
    try {
      const channels: Channel[] = await invoke("search", { filters: this.filters });
      this.items = more ? this.items.concat(channels) : channels;
      this.reachedMax = channels.length < PAGE_SIZE;
      if (!more) {
        this.itemIndex = 0;
        this.itemList?.nativeElement.scrollTo({ top: 0 });
        this.setInfo(this.items[0]);
        if (this.zone === "items" && !this.isGuide) setTimeout(() => this.focusItem(0));
      }
    } catch (e) {
      this.error.handleError(e);
    }
    this.loading = false;
  }

  layoutFor(c: Channel): "row" | "poster" {
    if (c.media_type === MediaType.serie || c.media_type === MediaType.season) return "poster";
    if (c.media_type === MediaType.movie && !this.filters?.season) return "poster";
    return "row";
  }

  get posterGrid(): boolean {
    return !!this.items.length && this.layoutFor(this.items[0]) === "poster";
  }

  onItemsScroll() {
    const el = this.itemList?.nativeElement;
    if (!el || this.reachedMax || this.loading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight * 0.75) this.load(true);
  }

  onGroupsScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (this.groupsReachedMax || this.groupsLoading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight * 0.75) this.loadGroups(true);
  }

  // ---------- series / seasons / hidden groups (drill-down) ----------

  private async openNode(id: number, name: string, type: NodeType, sourceId?: number) {
    const f = this.filters!;
    this.nodeStack.add(new Node(id, name, type, f.query, f.view_type));
    if (type == NodeType.Category) {
      f.group_id = id;
      if (f.view_type == ViewMode.Hidden) f.view_type = ViewMode.All;
    } else if (type == NodeType.Series) {
      f.series_id = id;
      f.source_ids = [sourceId!];
    } else if (type == NodeType.Season) f.season = id;
    this.clearSearch();
    await this.load();
    this.focusZone("items");
  }

  async goBack() {
    const node = this.nodeStack.pop();
    const f = this.filters!;
    if (node.type == NodeType.Category) f.group_id = undefined;
    else if (node.type == NodeType.Series) {
      f.series_id = undefined;
      f.source_ids = Array.from(this.memory.Sources.keys());
    } else if (node.type == NodeType.Season) f.season = undefined;
    if (node.query) {
      this.search.nativeElement.value = node.query;
      f.query = node.query;
    }
    if (node.fromViewType !== undefined) f.view_type = node.fromViewType;
    if (!this.nodeStack.hasNodes()) this.applyFilters();
    await this.load();
  }

  // ---------- info panel ----------

  async setInfo(c?: Channel) {
    this.info = c;
    this.infoNowNext = {};
    this.infoUpcoming = [];
    const seq = ++this.infoSeq;
    if (!c || !this.epg.hasEpg(c)) return;
    const programmes = await this.epg.get(c);
    if (seq !== this.infoSeq) return;
    this.infoNowNext = this.epg.nowNext(programmes);
    const after = this.infoNowNext.next;
    this.infoUpcoming = after ? programmes.filter((p) => p.start > after.start).slice(0, 3) : [];
  }

  get infoIsLive(): boolean {
    return this.info?.media_type === MediaType.livestream;
  }

  // ---------- playback from the guide ----------

  async playChannel(channel: Channel) {
    try {
      await invoke("play", { channel, record: false });
    } catch (e) {
      this.error.handleError(e);
    }
    invoke("add_last_watched", { id: channel.id }).catch((e) => this.error.handleError(e));
  }

  async playArchive({ channel, programme }: { channel: Channel; programme: Programme }) {
    try {
      await invoke("play", {
        channel: {
          id: -1,
          url: programme.timeshift_url,
          name: `${channel.name} - ${programme.title}`,
          media_type: MediaType.movie,
          favorite: false,
          source_id: channel.source_id,
        },
        record: false,
      });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  // ---------- header actions (kept from the original home screen) ----------

  clearSearch() {
    if (this.search) this.search.nativeElement.value = "";
    if (this.filters) this.filters.query = "";
  }

  async reload() {
    await Promise.all([this.load(), this.loadGroups()]);
  }

  async toggleKeywords() {
    this.filters!.use_keywords = !this.filters!.use_keywords;
    await this.load();
  }

  async bulkAction(action: BulkActionType) {
    if (this.filters?.series_id && !this.filters?.season) return;
    const actionName = BulkActionType[action].toLowerCase();
    try {
      await invoke("bulk_update", { filters: this.filters, action: action });
      await this.load();
      this.toast.success(`Successfully executed bulk update: ${actionName}`);
    } catch (e) {
      this.error.handleError(e);
    }
  }

  // ---------- focus ----------

  focusZone(zone: Zone) {
    if (zone === "groups" && !this.showGroups) zone = "rail";
    this.zone = zone;
    if (zone === "rail") this.focusRail(this.railIndex);
    else if (zone === "groups") this.focusGroup(this.groupIndex);
    else if (this.isGuide) (document.activeElement as HTMLElement)?.blur();
    else this.focusItem(this.itemIndex);
  }

  focusRail(i: number) {
    this.railIndex = Math.max(0, Math.min(this.sections.length, i)); // last slot = settings
    document.getElementById(`rail-${this.railIndex}`)?.focus();
  }

  focusGroup(i: number) {
    if (!this.groups.length) return;
    this.groupIndex = Math.max(0, Math.min(this.groups.length - 1, i));
    const el = document.getElementById(`group-${this.groupIndex}`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
    if (this.groupIndex >= this.groups.length - 6) this.loadGroups(true);
  }

  focusItem(i: number) {
    if (!this.items.length) return;
    this.itemIndex = Math.max(0, Math.min(this.items.length - 1, i));
    const el = document.getElementById(`tile-${this.itemIndex}`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
    this.setInfo(this.items[this.itemIndex]);
    if (this.itemIndex >= this.items.length - 6 && !this.reachedMax && !this.loading) this.load(true);
  }

  onItemFocus(i: number) {
    this.zone = "items";
    this.itemIndex = i;
  }

  private get gridColumns(): number {
    const tiles = this.itemList?.nativeElement.querySelectorAll<HTMLElement>("app-channel-tile");
    if (!tiles?.length) return 1;
    const top = tiles[0].offsetTop;
    let cols = 0;
    while (cols < tiles.length && tiles[cols].offsetTop === top) cols++;
    return cols;
  }

  private searchFocused(): boolean {
    return document.activeElement === this.search?.nativeElement;
  }

  // ---------- keyboard: remote-style navigation ----------

  @HostListener("document:keydown", ["$event"])
  async onKeyDown(e: KeyboardEvent) {
    if (this.player.full) return; // the player owns the keyboard
    if (this.memory.ModalRef || this.memory.currentContextMenu?.menuOpen) {
      if (e.key === "Escape") this.closeOverlays();
      return;
    }
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !this.searchFocused())) {
      e.preventDefault();
      this.search.nativeElement.focus();
      this.search.nativeElement.select();
      return;
    }
    if (this.searchFocused()) {
      if (e.key === "Escape" || e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        this.focusZone("items");
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === "Escape" || e.key === "Backspace" || e.key === "BrowserBack") {
      e.preventDefault();
      return this.back();
    }

    let handled = true;
    if (this.zone === "rail") handled = this.railKey(e);
    else if (this.zone === "groups") handled = this.groupsKey(e);
    else handled = this.itemsKey(e);
    if (handled) e.preventDefault();
  }

  @HostListener("document:keyup", ["$event"])
  onKeyUp(e: KeyboardEvent) {
    if (this.player.full) return;
    if (e.key !== "Enter" || this.zone !== "items" || this.isGuide || this.longPress === undefined) return;
    clearTimeout(this.longPress);
    this.longPress = undefined;
    if (!this.longPressFired) this.tiles.get(this.itemIndex)?.click();
  }

  private railKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowUp":
        this.focusRail(this.railIndex - 1);
        return true;
      case "ArrowDown":
        this.focusRail(this.railIndex + 1);
        return true;
      case "Enter":
      case "ArrowRight": {
        if (this.railIndex === this.sections.length) {
          if (e.key === "Enter") this.openSettings();
          return true;
        }
        const section = this.sections[this.railIndex];
        this.focusZone(section.groups ? "groups" : "items");
        if (section !== this.section) this.selectSection(section);
        return true;
      }
    }
    return false;
  }

  private groupsKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "PageUp":
      case "PageDown": {
        const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
        this.focusGroup(this.groupIndex + step);
        // Like TiviMate, the channel list follows the focused group once you stop scrolling.
        clearTimeout(this.groupSettle);
        this.groupSettle = window.setTimeout(() => this.selectGroup(this.groupIndex), GROUP_SETTLE_MS);
        return true;
      }
      case "ArrowLeft":
        this.focusZone("rail");
        return true;
      case "Enter":
      case "ArrowRight":
        clearTimeout(this.groupSettle);
        this.focusZone("items");
        this.selectGroup(this.groupIndex); // reloads and focuses the first channel
        return true;
    }
    return false;
  }

  private itemsKey(e: KeyboardEvent): boolean {
    if (this.isGuide) {
      if (this.grid?.handleKey(e)) return true;
      return false;
    }
    const cols = this.posterGrid ? this.gridColumns : 1;
    switch (e.key) {
      case "ArrowUp":
        this.focusItem(this.itemIndex - cols);
        return true;
      case "ArrowDown":
        this.focusItem(this.itemIndex + cols);
        return true;
      case "PageUp":
        this.focusItem(this.itemIndex - 10 * cols);
        return true;
      case "PageDown":
        this.focusItem(this.itemIndex + 10 * cols);
        return true;
      case "Home":
        this.focusItem(0);
        return true;
      case "End":
        this.focusItem(this.items.length - 1);
        return true;
      case "ArrowLeft":
        if (cols > 1 && this.itemIndex % cols !== 0) this.focusItem(this.itemIndex - 1);
        else this.focusZone("groups");
        return true;
      case "ArrowRight":
        if (cols > 1) this.focusItem(this.itemIndex + 1);
        return true;
      case "Enter":
        // Short press plays; holding Enter opens the context menu (TiviMate's long-press OK).
        if (!e.repeat) {
          this.longPressFired = false;
          this.longPress = window.setTimeout(() => {
            this.longPressFired = true;
            this.tiles.get(this.itemIndex)?.openMenuFromKeyboard();
          }, LONG_PRESS_MS);
        }
        return true;
      case "ContextMenu":
        this.tiles.get(this.itemIndex)?.openMenuFromKeyboard();
        return true;
    }
    if (/^[0-9]$/.test(e.key) && !this.posterGrid) {
      this.typeNumber(e.key);
      return true;
    }
    return false;
  }

  /** Type a channel number to jump to it. */
  private typeNumber(digit: string) {
    this.numberEntry = (this.numberEntry + digit).slice(-4);
    clearTimeout(this.numberTimer);
    this.numberTimer = window.setTimeout(() => {
      const n = +this.numberEntry;
      this.numberEntry = "";
      if (n > 0 && n <= this.items.length) this.focusItem(n - 1);
    }, 1000);
  }

  get typedNumber(): string {
    return this.numberEntry;
  }

  private closeOverlays() {
    const modal = this.memory.ModalRef;
    if (
      modal &&
      (modal.componentInstance.name != "RestreamModalComponent" || !modal.componentInstance.started)
    ) {
      modal.close("close");
      this.memory.ModalRef = undefined;
    }
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
  }

  private async back() {
    if (this.filters?.query) {
      this.clearSearch();
      await this.load();
    } else if (this.nodeStack.hasNodes()) {
      await this.goBack();
      this.focusZone("items");
    } else if (this.zone === "items") this.focusZone("groups");
    else if (this.zone === "groups") this.focusZone("rail");
    else if (this.player.preview) this.player.setMode("full"); // TiviMate: Back from the menu returns to the video
  }
}
