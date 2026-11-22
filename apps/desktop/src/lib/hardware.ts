import { create } from "zustand";
import { t } from "../i18n/de";
import { backend } from "./backend";
import { settleWebSync } from "./web/sync";
import type {
  BoardArg,
  BoardEntry,
  BoardOption,
  BuildOutcome,
  DeviceInfo,
  LibraryInfo,
  MemoryDetail,
  OutdatedItem,
  MonitorLine,
  MonitorState,
  PartitionInfo,
  SecretStatus,
  SizeInfo,
  ToolchainStatus,
} from "./backend";
import type { Diagnostic } from "./diagnostics";
import { boardForChip, chipFamily, chipOf, familyOfFqbn } from "./boards";
import { baseName, errorText, isCancelled, useStore } from "./store";

export type Activity = "idle" | "checking" | "compiling" | "flashing";

export interface BuildView {
  /** Anzeige der Stufen. `flash` zeigt alle sechs, `compile` die ersten beiden. */
  mode: "compile" | "flash";
  status: "running" | "done" | "error";
  stage: number;
  progress: number;
  detail: string;
  title: string;
  target?: string;
}

export interface PlotSeriesData {
  name: string;
  values: number[];
}

const MAX_LINES = 2000;
const MAX_SAMPLES = 2000;
const MAX_SERIES = 8;

const DEVICE_KEY = (project: string) => `forge.device.${project}`;

function readRemembered(project: string): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY(project));
  } catch {
    return null;
  }
}

function remember(project: string, id: string | null) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY(project), id);
    else localStorage.removeItem(DEVICE_KEY(project));
  } catch {
    /* Ohne Speicher gilt die Auswahl nur für diese Sitzung. */
  }
}

/** Automatische Auswahl: erinnertes Gerät, sonst das einzige passende. */
export function chooseDevice(devices: DeviceInfo[], remembered: string | null, current: string | null): string | null {
  if (current && devices.some((d) => d.id === current)) return current;
  if (remembered && devices.some((d) => d.id === remembered)) return remembered;
  // Ein Kabel schlägt WLAN: Boards im Netzwerk wählt Forge nur, wenn kein USB-Board da ist.
  const usb = devices.filter((d) => d.likelyEsp && d.transport !== "network");
  if (usb.length) return usb.length === 1 ? usb[0].id : null;
  const net = devices.filter((d) => d.likelyEsp);
  return net.length === 1 ? net[0].id : null;
}

export const isNetwork = (d: DeviceInfo | null | undefined) => d?.transport === "network";

/** Liest Werte für den Plotter: `name:wert`-Paare oder durch Komma, Tab oder Leerzeichen getrennte Zahlen. */
export function parsePlotLine(text: string): Array<[string, number]> {
  const pairs = [...text.matchAll(/([A-Za-z_][\w .-]*?)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)];
  if (pairs.length) return pairs.map((m) => [m[1].trim(), Number(m[2])]);
  const parts = text.trim().split(/[\s,;\t]+/);
  if (parts.length && parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) return parts.map((p, i) => [`Wert ${i + 1}`, Number(p)]);
  return [];
}

export function formatBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(2).replace(".", ",")} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

interface Hardware {
  toolchain: ToolchainStatus | null;
  setup: { running: boolean; line: string; fraction: number | null };
  boards: BoardEntry[];
  boardOptions: Record<string, BoardOption[]>;
  devices: DeviceInfo[];
  devicesLoaded: boolean;
  /** Was esptool über das Board gemeldet hat, je Geräte-ID. */
  identity: Record<string, { chip: string; mac: string | null }>;
  identifying: string | null;
  selectedDeviceId: string | null;
  activity: Activity;
  build: BuildView | null;
  lastBuild: BuildOutcome | null;
  monitor: { open: boolean; state: MonitorState; baud: number; userClosed: boolean };
  monitorLines: MonitorLine[];
  plot: PlotSeriesData[];
  plotPaused: boolean;
  libraries: LibraryInfo[];
  libraryBusy: Record<string, number | null>;
  /** Suchbegriff der Bibliotheksansicht. Andere Teile der Oberfläche können ihn setzen. */
  libraryQuery: string;
  secrets: SecretStatus[];
  /** Bibliotheken mit neuerer Version (`arduino-cli outdated`). */
  outdated: OutdatedItem[];
  coreUpgrading: boolean;
  /** Abschnitte und größte Symbole des letzten Builds. */
  memory: { state: "idle" | "loading" | "ready" | "error"; data: MemoryDetail | null; error: string | null };

  init(): Promise<void>;
  runSetup(): Promise<boolean>;
  runSetupNrf(): Promise<boolean>;
  loadBoards(): Promise<void>;
  loadOptions(fqbn: string): Promise<BoardOption[]>;
  setBoard(fqbn: string, options: Record<string, string>): Promise<void>;
  refreshDevices(): Promise<void>;
  selectDevice(id: string | null): void;
  /** Fragt den Chip des Boards und schlägt das passende Board vor. */
  identify(id: string, force?: boolean): Promise<void>;
  selectedDevice(): DeviceInfo | null;
  board(): BoardArg | null;

  /** Prüft, ob arduino-cli und der ESP32-Core da sind. Sonst öffnet sich die Einrichtung. */
  ensureToolchain(): boolean;
  compile(opts?: { force?: boolean }): Promise<void>;
  flash(opts?: { force?: boolean; eraseAll?: boolean }): Promise<void>;
  cancel(): Promise<void>;

  startMonitor(): Promise<void>;
  stopMonitor(): Promise<void>;
  sendToMonitor(text: string, ending: "none" | "nl" | "cr" | "nlcr"): Promise<void>;
  clearMonitor(): void;
  setBaud(baud: number): Promise<void>;
  resetBoard(): Promise<void>;
  togglePlotPause(): void;

  searchLibrary(query: string): void;
  refreshSecrets(): Promise<void>;
  setSecret(name: string, value: string, global: boolean): Promise<boolean>;
  removeSecret(name: string): Promise<void>;
  refreshLibraries(): Promise<void>;
  installLibrary(name: string, version?: string): Promise<void>;
  uninstallLibrary(name: string): Promise<void>;
  upgradeLibrary(name: string): Promise<void>;

  refreshOutdated(): Promise<void>;
  upgradeAllLibraries(): Promise<void>;
  installLibraryZip(): Promise<void>;
  upgradeCore(): Promise<void>;
  loadMemory(): Promise<void>;
}

let progressToast: number | null = null;
let initialized = false;

function endProgressToast() {
  if (progressToast != null) {
    useStore.getState().dismissToast(progressToast);
    progressToast = null;
  }
}

export const useHardware = create<Hardware>((set, get) => ({
  toolchain: null,
  setup: { running: false, line: "", fraction: null },
  boards: [],
  boardOptions: {},
  devices: [],
  devicesLoaded: false,
  identity: {},
  identifying: null,
  selectedDeviceId: null,
  activity: "idle",
  build: null,
  lastBuild: null,
  monitor: { open: false, state: { state: "closed" }, baud: 115200, userClosed: false },
  monitorLines: [],
  plot: [],
  plotPaused: false,
  libraries: [],
  libraryBusy: {},
  libraryQuery: "",
  secrets: [],
  outdated: [],
  coreUpgrading: false,
  memory: { state: "idle", data: null, error: null },

  async init() {
    if (initialized) return;
    initialized = true;
    const b = backend();
    try {
      set({ toolchain: await b.toolchainStatus() });
    } catch (e) {
      set({ toolchain: { arduinoCli: null, esp32Core: null, esptool: false, error: errorText(e) } });
    }
    // Paketliste im Hintergrund erneuern, wenn sie älter als 24 Stunden ist. Danach stimmen die Updates.
    void (async () => {
      try {
        if (await b.refreshIndexIfStale()) set({ toolchain: await b.toolchainStatus() });
      } catch {
        /* Offline: es gilt die Liste von zuletzt. */
      }
      await get().refreshOutdated();
    })();

    // Anzeigen des alten Projekts (Speicherzahlen, Monitor, Plotter) gelten nicht für das neue.
    window.addEventListener("forge:project-switched", () => set({ lastBuild: null, build: null, monitorLines: [], plot: [], memory: { state: "idle", data: null, error: null } }));

    // Die Abos laufen so lange wie die App.
    await Promise.all([
      b.onDevicesChanged((list) => applyDevices(list)),
      b.onBuildEvent((e) => {
        if (e.kind === "output") {
          useStore.getState().appendOutput([{ text: e.line, kind: e.level === "err" ? "err" : e.level === "warn" ? "warn" : e.level === "cmd" ? "cmd" : undefined }]);
          return;
        }
        const cur = get().build;
        if (!cur) return;
        // Stufen laufen nur vorwärts. Späte Ereignisse einer früheren Stufe stören die Anzeige nicht.
        if (e.stage < cur.stage) return;
        set({ build: { ...cur, stage: e.stage, progress: e.progress, detail: e.detail } });
        if (progressToast != null) {
          const total = cur.mode === "compile" ? 2 : 6;
          useStore.getState().updateToast(progressToast, { message: e.detail, progress: Math.min(1, (e.stage + e.progress) / total) });
        }
      }),
      b.onMonitorLines((lines) => pushLines(lines)),
      b.onMonitorState((s) => set((st) => ({ monitor: { ...st.monitor, state: s, open: s.state !== "closed" || st.monitor.open } }))),
      b.onLibraryProgress((p) => set((st) => ({ libraryBusy: { ...st.libraryBusy, [p.name]: p.fraction ?? null } }))),
    ]);

    await get().refreshDevices();
  },

  async runSetup() {
    set({ setup: { running: true, line: "", fraction: null } });
    const off = await backend().onToolchainProgress((p) => set((s) => ({ setup: { running: true, line: p.line, fraction: p.fraction ?? s.setup.fraction } })));
    try {
      await backend().toolchainSetup();
      set({ toolchain: await backend().toolchainStatus(), setup: { running: false, line: "", fraction: null } });
      await get().loadBoards();
      return true;
    } catch (e) {
      set({ setup: { running: false, line: "", fraction: null } });
      useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) });
      return false;
    } finally {
      off();
    }
  },

  async runSetupNrf() {
    set({ setup: { running: true, line: "", fraction: null } });
    const off = await backend().onToolchainProgress((p) => set((s) => ({ setup: { running: true, line: p.line, fraction: p.fraction ?? s.setup.fraction } })));
    try {
      await backend().toolchainSetupNrf();
      set({ toolchain: await backend().toolchainStatus(), setup: { running: false, line: "", fraction: null } });
      await get().loadBoards();
      return true;
    } catch (e) {
      set({ setup: { running: false, line: "", fraction: null } });
      useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) });
      return false;
    } finally {
      off();
    }
  },

  async loadBoards() {
    try {
      set({ boards: await backend().boards() });
    } catch {
      set({ boards: [] });
    }
  },

  async loadOptions(fqbn) {
    const cached = get().boardOptions[fqbn];
    if (cached) return cached;
    try {
      const opts = await backend().boardOptions(fqbn);
      set((s) => ({ boardOptions: { ...s.boardOptions, [fqbn]: opts } }));
      return opts;
    } catch {
      return [];
    }
  },

  async setBoard(fqbn, options) {
    try {
      const project = await backend().setBoard(fqbn, options);
      useStore.setState({ project });
    } catch (e) {
      useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) });
    }
  },

  async refreshDevices() {
    try {
      applyDevices(await backend().devices());
    } catch {
      applyDevices([]);
    }
  },

  selectDevice(id) {
    const project = useStore.getState().project;
    if (project) remember(project.path, id);
    set((s) => ({ selectedDeviceId: id, monitor: { ...s.monitor, userClosed: false } }));
    const { monitor } = get();
    if (monitor.open) void get().startMonitor();
  },

  async identify(id, force = false) {
    const st = get();
    const device = st.devices.find((d) => d.id === id);
    if (!device || !device.likelyEsp || device.bridge === "nrf52" || isNetwork(device) || st.identifying || st.activity !== "idle") return;
    if (!force && st.identity[id]) return;
    const cached = force ? null : readChip(id);
    if (cached) {
      set((s) => ({ identity: { ...s.identity, [id]: cached } }));
      suggestBoard(cached.chip);
      return;
    }
    if (failedProbes.has(id) && !force) return;
    // Der Monitor hält den Port. Für die Abfrage gibt er ihn kurz frei.
    const monitorWasOpen = st.monitor.state.state !== "closed";
    set({ identifying: id });
    if (monitorWasOpen) await backend().monitorStop().catch(() => undefined);
    try {
      const probe = await backend().probeDevice(device.port);
      const found = { chip: probe.chip, mac: probe.mac };
      set((s) => ({ identity: { ...s.identity, [id]: found } }));
      rememberChip(id, found);
      failedProbes.delete(id);
      suggestBoard(probe.chip);
    } catch (e) {
      failedProbes.add(id);
      if (force) useStore.getState().toast({ kind: "warning", title: t.device.identifyFailed, message: errorText(e) });
    } finally {
      set({ identifying: null });
      if (monitorWasOpen) void get().startMonitor();
    }
  },

  selectedDevice() {
    const { devices, selectedDeviceId } = get();
    return devices.find((d) => d.id === selectedDeviceId) ?? null;
  },

  board() {
    const p = useStore.getState().project;
    return p ? { fqbn: p.config.board.fqbn, options: p.config.board.options } : null;
  },

  ensureToolchain() {
    const tc = get().toolchain;
    if (tc && tc.arduinoCli && tc.esp32Core) return true;
    useStore.getState().setDialog({ kind: "toolchain" });
    return false;
  },

  async compile(opts) {
    const s = useStore.getState();
    const board = get().board();
    if (!s.project || !board || get().activity !== "idle" || !get().ensureToolchain()) return;
    if (!(await s.saveAll()) || !(await settleWebSync())) return;
    const name = s.project.name;
    set({ activity: "compiling", build: { mode: "compile", status: "running", stage: 0, progress: 0, detail: "Starte", title: t.hardware.buildStart(name) } });
    progressToast = s.toast({ kind: "progress", title: t.hardware.buildStart(name), message: "", progress: 0, onCancel: () => void get().cancel() });
    s.clearOutput();
    s.setBottomTab("output");
    try {
      const outcome = await backend().build(board, opts?.force ?? false);
      handleBuildOutcome(outcome, false);
    } catch (e) {
      failBuild(e);
    }
  },

  async flash(opts) {
    const s = useStore.getState();
    const board = get().board();
    if (!s.project || !board || get().activity !== "idle" || !get().ensureToolchain()) return;
    const device = get().selectedDevice();
    if (!device) {
      s.toast({ kind: "warning", title: t.hardware.noBoardTitle, message: t.hardware.noBoardText, actions: [{ label: t.hardware.rescan, run: () => void get().refreshDevices() }] });
      return;
    }
    if (!(await s.saveAll()) || !(await settleWebSync())) return;
    const chip = chipOf(board.fqbn);
    set({ activity: "flashing", build: { mode: "flash", status: "running", stage: 0, progress: 0, detail: "Starte", title: t.hardware.flashStart(chip), target: baseName(device.port) } });
    progressToast = s.toast({ kind: "progress", title: t.hardware.flashStart(chip), message: "", progress: 0, onCancel: () => void get().cancel() });
    s.clearOutput();
    try {
      const net = isNetwork(device) && device.host ? device : null;
      const result = await backend().flash({
        board,
        port: device.port,
        deviceId: device.id,
        eraseAll: opts?.eraseAll ?? false,
        force: opts?.force ?? false,
        target: net ? { kind: "network", host: net.host!, port: net.otaPort ?? 3232 } : undefined,
      });
      endProgressToast();
      if (result.status === "secretsMissing") {
        set({ activity: "idle", build: null });
        s.toast({
          kind: "warning",
          title: t.secrets.missingTitle,
          message: result.names.join(", "),
          actions: [{ label: t.secrets.setUp, run: () => useStore.getState().setDialog({ kind: "secrets" }), primary: true }],
        });
        void get().refreshSecrets();
        return;
      }
      if (result.status === "buildFailed") {
        handleBuildOutcome(result.build, true);
        return;
      }
      set({ activity: "idle", lastBuild: result.build, build: { mode: "flash", status: "done", stage: 5, progress: 1, detail: "Fertig", title: t.hardware.flashDone, target: baseName(device.port) } });
      if (result.status === "alreadyCurrent") {
        s.toast({ kind: "info", title: t.hardware.alreadyCurrent, message: t.hardware.alreadyCurrentText, actions: [{ label: t.hardware.flashAnyway, run: () => void get().flash({ force: true }) }], ttl: 8000 });
        return;
      }
      s.toast({ kind: "success", title: t.hardware.flashDone, message: t.hardware.flashDoneText(formatBytes(result.flash.bytes), (result.flash.durationMs / 1000).toFixed(1).replace(".", ",")) });
      // Nach dem Flashen interessiert die Ausgabe des Boards.
      if (!isNetwork(device)) s.setBottomTab("monitor");
      if (!isNetwork(device) && !get().monitor.open) void get().startMonitor();
    } catch (e) {
      failBuild(e, true);
    }
  },

  async cancel() {
    await backend().cancelBuild().catch(() => undefined);
  },

  async startMonitor() {
    const device = get().selectedDevice();
    // Boards im WLAN haben keinen seriellen Port.
    if (!device || isNetwork(device)) return;
    set((s) => ({ monitor: { ...s.monitor, open: true, userClosed: false } }));
    await backend().monitorStart(device.id, device.port, get().monitor.baud).catch((e) => useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) }));
  },

  async stopMonitor() {
    await backend().monitorStop().catch(() => undefined);
    set((s) => ({ monitor: { ...s.monitor, open: false, userClosed: true, state: { state: "closed" } } }));
  },

  async sendToMonitor(text, ending) {
    await backend().monitorWrite(text, ending).catch((e) => useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) }));
  },

  clearMonitor: () => set({ monitorLines: [], plot: [] }),

  async setBaud(baud) {
    if (!Number.isInteger(baud) || baud < 300 || baud > 4_000_000) return;
    set((s) => ({ monitor: { ...s.monitor, baud } }));
    if (!get().monitor.open) return;
    // Läuft der Monitor, wird nur die Rate umgestellt. Der Port bleibt offen.
    if (get().monitor.state.state === "connected") {
      await backend().monitorSetBaud(baud).catch((e) => useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) }));
    } else {
      await get().startMonitor();
    }
  },

  async resetBoard() {
    await backend().monitorReset().catch((e) => useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) }));
  },

  togglePlotPause: () => set((s) => ({ plotPaused: !s.plotPaused })),

  searchLibrary(query) {
    set({ libraryQuery: query });
    useStore.getState().setSidebarViewOpen("library");
  },

  async refreshSecrets() {
    if (!useStore.getState().project) return set({ secrets: [] });
    try {
      set({ secrets: await backend().secrets() });
    } catch {
      set({ secrets: [] });
    }
  },

  async setSecret(name, value, global) {
    try {
      await backend().setSecret(name, value, global);
      await get().refreshSecrets();
      useStore.getState().toast({ kind: "success", title: t.secrets.saved(name) });
      return true;
    } catch (e) {
      useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) });
      return false;
    }
  },

  async removeSecret(name) {
    try {
      await backend().removeSecret(name);
    } catch (e) {
      useStore.getState().toast({ kind: "error", title: t.errors.generic, message: errorText(e) });
    }
    await get().refreshSecrets();
  },

  async refreshLibraries() {
    try {
      set({ libraries: await backend().libraries() });
    } catch {
      set({ libraries: [] });
    }
  },

  async installLibrary(name, version) {
    await libraryOp(name, () => backend().installLibrary(name, version), t.libraries.installed_ok(name));
  },
  async uninstallLibrary(name) {
    await libraryOp(name, () => backend().uninstallLibrary(name), t.libraries.removed(name));
  },
  async upgradeLibrary(name) {
    await libraryOp(name, () => backend().upgradeLibrary(name), t.libraries.installed_ok(name));
    await get().refreshOutdated();
  },

  async refreshOutdated() {
    try {
      set({ outdated: await backend().outdatedLibraries() });
    } catch {
      set({ outdated: [] });
    }
  },

  async upgradeAllLibraries() {
    const names = get().outdated.map((o) => o.name);
    for (const name of names) await libraryOp(name, () => backend().upgradeLibrary(name), t.libraries.installed_ok(name));
    await get().refreshOutdated();
  },

  async installLibraryZip() {
    const path = await backend().pickLibraryZip();
    if (!path) return;
    const name = baseName(path).replace(/\.zip$/i, "");
    await libraryOp(name, () => backend().installLibraryZip(path), t.libraries.installed_ok(name));
    await get().refreshOutdated();
  },

  async upgradeCore() {
    if (get().coreUpgrading) return;
    set({ coreUpgrading: true, setup: { running: true, line: "", fraction: null } });
    const off = await backend().onToolchainProgress((p) => set((s) => ({ setup: { running: true, line: p.line, fraction: p.fraction ?? s.setup.fraction } })));
    try {
      await backend().coreUpgrade();
      const status = await backend().toolchainStatus();
      set({ toolchain: status });
      useStore.getState().toast({ kind: "success", title: t.updates.coreUpgraded(status.esp32Core ?? "") });
    } catch (e) {
      useStore.getState().toast({ kind: "error", title: t.updates.coreFailed, message: errorText(e) });
    } finally {
      off();
      set({ coreUpgrading: false, setup: { running: false, line: "", fraction: null } });
    }
  },

  async loadMemory() {
    set((s) => ({ memory: { ...s.memory, state: "loading", error: null } }));
    try {
      set({ memory: { state: "ready", data: await backend().memoryDetail(), error: null } });
    } catch (e) {
      set({ memory: { state: "error", data: null, error: errorText(e) } });
    }
  },
}));

async function libraryOp(name: string, run: () => Promise<void>, done: string) {
  useHardware.setState((s) => ({ libraryBusy: { ...s.libraryBusy, [name]: null } }));
  try {
    await run();
    await useHardware.getState().refreshLibraries();
    useStore.getState().toast({ kind: "success", title: done });
  } catch (e) {
    useStore.getState().toast({ kind: "error", title: t.libraries.failed, message: errorText(e) });
  } finally {
    useHardware.setState((s) => {
      const { [name]: _gone, ...rest } = s.libraryBusy;
      return { libraryBusy: rest };
    });
  }
}

const failedProbes = new Set<string>();
const suggested = new Set<string>();

const CHIP_KEY = (id: string) => `forge.chip.${id}`;

function readChip(id: string): { chip: string; mac: string | null } | null {
  if (id.startsWith("port:")) return null;
  try {
    const raw = localStorage.getItem(CHIP_KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function rememberChip(id: string, value: { chip: string; mac: string | null }) {
  // Ohne Seriennummer ist die ID nur der Portname und zeigt später vielleicht auf ein anderes Board.
  if (id.startsWith("port:")) return;
  try {
    localStorage.setItem(CHIP_KEY(id), JSON.stringify(value));
  } catch {
    /* Ohne Speicher wird beim nächsten Start neu gefragt. */
  }
}

/** Passt das erkannte Board nicht zum Projekt, bietet Forge das richtige an. Pro Chip und Projekt nur einmal. */
function suggestBoard(chip: string) {
  const s = useStore.getState();
  const project = s.project;
  if (!project) return;
  const current = familyOfFqbn(project.config.board.fqbn);
  const family = chipFamily(chip);
  const key = `${project.path}|${family}`;
  if (!current || current === family || suggested.has(key)) return;
  suggested.add(key);
  const board = boardForChip(chip);
  s.toast({
    kind: "info",
    title: t.device.detected(family),
    message: t.device.detectedText(board.name),
    actions: [{ label: t.device.switchBoard, primary: true, run: () => void useHardware.getState().setBoard(board.fqbn, {}) }],
    ttl: 20000,
  });
}

function applyDevices(list: DeviceInfo[]) {
  const s = useStore.getState();
  const project = s.project;
  const prev = useHardware.getState();
  const remembered = project ? readRemembered(project.path) : null;
  const selected = chooseDevice(list, remembered, prev.selectedDeviceId);
  useHardware.setState({ devices: list, devicesLoaded: true, selectedDeviceId: selected });
  if (selected) void useHardware.getState().identify(selected);
  // Ist das gewählte Board weg, hört der Monitor von selbst auf zu streamen. Die Anzeige zeigt es.
}

/** Auswertung des Builds: Diagnosen, Meldung, Speicherzahlen. */
function handleBuildOutcome(outcome: BuildOutcome, fromFlash: boolean) {
  const s = useStore.getState();
  endProgressToast();
  const hw = useHardware;
  applyDiagnostics(outcome.diagnostics);

  if (outcome.status === "failed") {
    hw.setState((st) => ({ activity: "idle", build: st.build ? { ...st.build, status: "error", detail: t.hardware.buildFailed } : null }));
    const first = outcome.diagnostics.find((d) => d.severity === "error");
    s.setBottomTab(outcome.diagnostics.length ? "problems" : "output");
    s.toast({
      kind: "error",
      title: t.hardware.buildFailed,
      message: first ? `${baseName(first.file)}, Zeile ${first.line}: ${first.message}` : (outcome.error ?? undefined),
      actions: first ? [{ label: t.hardware.toError, run: () => revealDiagnostic(first) }] : undefined,
    });
    return;
  }
  hw.setState({ activity: "idle", lastBuild: outcome, build: { mode: fromFlash ? "flash" : "compile", status: "done", stage: 1, progress: 1, detail: "Fertig", title: t.hardware.buildOk } });
  if (outcome.status === "skipped") {
    s.toast({ kind: "info", title: t.hardware.unchanged, message: t.hardware.unchangedText });
  } else {
    const flash = outcome.sizes.find((x) => x.label === "Flash");
    s.toast({ kind: "success", title: t.hardware.buildOk, message: flash ? t.hardware.buildOkText(`${formatBytes(flash.used)} (${Math.round((flash.used / flash.total) * 100)} %)`) : undefined });
  }
}

function failBuild(e: unknown, fromFlash = false) {
  endProgressToast();
  const s = useStore.getState();
  const message = errorText(e);
  useHardware.setState((st) => ({ activity: "idle", build: st.build ? { ...st.build, status: "error" } : null }));
  if (isCancelled(e)) {
    s.toast({ kind: "info", title: t.hardware.cancelled });
    return;
  }
  s.setBottomTab("output");
  s.toast({
    kind: "error",
    title: fromFlash ? t.hardware.flashFailed : t.hardware.buildFailed,
    message,
    actions: [{ label: t.errors.retry, run: () => void (fromFlash ? useHardware.getState().flash() : useHardware.getState().compile()) }],
  });
}

function applyDiagnostics(list: Diagnostic[]) {
  const s = useStore.getState();
  s.clearDiagnostics("compiler");
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of list) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
  for (const [file, ds] of byFile) s.setDiagnostics("compiler", file, ds);
}

export function revealDiagnostic(d: Diagnostic) {
  window.dispatchEvent(new CustomEvent("forge:reveal", { detail: d }));
}

function pushLines(lines: MonitorLine[]) {
  useHardware.setState((s) => {
    const monitorLines = [...s.monitorLines, ...lines].slice(-MAX_LINES);
    if (s.plotPaused) return { monitorLines };
    const series = new Map(s.plot.map((p) => [p.name, p.values]));
    for (const l of lines) {
      if (l.kind !== "rx") continue;
      for (const [name, value] of parsePlotLine(l.text)) {
        if (!series.has(name) && series.size >= MAX_SERIES) continue;
        series.set(name, [...(series.get(name) ?? []), value].slice(-MAX_SAMPLES));
      }
    }
    return { monitorLines, plot: [...series].map(([name, values]) => ({ name, values })) };
  });
}

export type { PartitionInfo, SizeInfo };
