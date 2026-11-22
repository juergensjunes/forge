import type { Diagnostic } from "../diagnostics";
import type { Backend, Unsubscribe } from "./backend";
import type {
  AiBlockResult,
  AiRun,
  AiThread,
  AiState,
  BoardEntry,
  FbuildStatus,
  BoardOption,
  BuildEvent,
  BuildOutcome,
  DeviceInfo,
  ExampleInfo,
  FlashResult,
  LibraryInfo,
  LibraryProgress,
  LibrarySearchHit,
  McpStatus,
  MemoryDetail,
  OutdatedItem,
  SearchOptions,
  SearchResult,
  ModelList,
  BacktraceFrame,
  MonitorLine,
  SecretStatus,
  MonitorState,
  ToolchainProgress,
} from "./types";

type Handler<T> = (v: T) => void;

class Emitter<T> {
  private handlers = new Set<Handler<T>>();
  on = async (h: Handler<T>): Promise<Unsubscribe> => {
    this.handlers.add(h);
    return () => void this.handlers.delete(h);
  };
  emit(v: T) {
    this.handlers.forEach((h) => h(v));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const MOCK_DEVICE: DeviceInfo = {
  id: "usb:303a:1001:7c:df:a1:12:34:56",
  port: "/dev/cu.usbmodem1101",
  vid: 0x303a,
  pid: 0x1001,
  serial: "7C:DF:A1:12:34:56",
  product: "USB JTAG/serial debug unit",
  manufacturer: "Espressif",
  bridge: "esp-native",
  label: "ESP32 (USB-Serial/JTAG)",
  likelyEsp: true,
  mac: "7c:df:a1:12:34:56",
};

/** Ein Board im WLAN, das ArduinoOTA anbietet. */
export const MOCK_NET_DEVICE: DeviceInfo = {
  id: "net:esp32s3-wohnzimmer",
  port: "esp32s3-wohnzimmer.local",
  vid: 0,
  pid: 0,
  serial: null,
  product: "ESP32S3 Dev Module",
  manufacturer: null,
  bridge: "network",
  label: "ESP32 (WLAN)",
  likelyEsp: true,
  mac: null,
  transport: "network",
  host: "192.168.1.42",
  otaPort: 3232,
  auth: true,
};

const BLINK_EXAMPLE = "void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(1000);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(1000);\n}\n";

/** Beispiele im Vorschaumodus: Pfad zu Quelltext. */
export const MOCK_EXAMPLE_SOURCES: Record<string, string> = {
  "/mock/esp32/libraries/WiFi/examples/WiFiScan/WiFiScan.ino": '#include "WiFi.h"\n\nvoid setup() {\n  Serial.begin(115200);\n  WiFi.mode(WIFI_STA);\n}\n\nvoid loop() {\n  int n = WiFi.scanNetworks();\n  Serial.printf("%d Netzwerke\\n", n);\n  delay(5000);\n}\n',
  "/mock/esp32/libraries/WiFi/examples/WiFiClient/WiFiClient.ino": '#include <WiFi.h>\n\nvoid setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n}\n',
  "/mock/esp32/libraries/ESP32/examples/ChipID/GetChipID/GetChipID.ino": "void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  Serial.printf(\"%llx\\n\", ESP.getEfuseMac());\n  delay(3000);\n}\n",
  "/mock/esp32/libraries/ArduinoOTA/examples/BasicOTA/BasicOTA.ino": '#include <ArduinoOTA.h>\n\nvoid setup() {\n  ArduinoOTA.begin();\n}\n\nvoid loop() {\n  ArduinoOTA.handle();\n}\n',
  "/mock/libraries/Adafruit_NeoPixel/examples/simple/simple.ino": "#include <Adafruit_NeoPixel.h>\n\nAdafruit_NeoPixel strip(1, 48, NEO_GRB + NEO_KHZ800);\n\nvoid setup() {\n  strip.begin();\n}\n\nvoid loop() {\n  strip.setPixelColor(0, strip.Color(0, 40, 0));\n  strip.show();\n}\n",
  "/mock/libraries/Adafruit_NeoPixel/examples/strandtest/strandtest.ino": BLINK_EXAMPLE,
  "/mock/libraries/ArduinoJson/examples/JsonParserExample/JsonParserExample.ino": '#include <ArduinoJson.h>\n\nvoid setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n}\n',
};

const MOCK_EXAMPLES: ExampleInfo[] = Object.keys(MOCK_EXAMPLE_SOURCES)
  .map((path) => {
    const parts = path.split("/");
    const core = path.startsWith("/mock/esp32/");
    const library = parts[parts.indexOf("libraries") + 1];
    return { library: library.replace(/_/g, " "), name: parts[parts.length - 2], path: path.slice(0, path.lastIndexOf("/")), source: core ? "core" : "library" } as ExampleInfo;
  })
  .sort((a, b) => Number(a.source !== "core") - Number(b.source !== "core") || a.library.localeCompare(b.library) || a.name.localeCompare(b.name));

const MOCK_MEMORY: MemoryDetail = {
  groups: [
    { label: "IRAM", size: 84_019, sections: [[".iram0.vectors", 1028], [".iram0.text", 82_991]] },
    { label: "DRAM", size: 47_381, sections: [[".dram0.data", 23_933], [".dram0.bss", 23_448]] },
    { label: "Flash-Code", size: 692_652, sections: [[".flash.text", 692_652]] },
    { label: "Rodata", size: 125_108, sections: [[".flash.appdesc", 256], [".flash.rodata", 114_324], [".eh_frame", 10_528]] },
  ],
  symbols: [
    { name: "WiFiGenericClass::_eventCallback(void*, esp_event_base_t, int, void*)", size: 18_240, kind: "code" },
    { name: "mbedtls_ssl_handshake_client_step", size: 14_912, kind: "code" },
    { name: "lwip_pbuf_pool", size: 12_288, kind: "bss" },
    { name: "Adafruit_NeoPixel::show()", size: 6_904, kind: "code" },
    { name: "font_5x7", size: 5_120, kind: "rodata" },
    { name: "Serial1", size: 4_328, kind: "data" },
    { name: "loopTask(void*)", size: 3_776, kind: "code" },
    { name: "wifi_rx_buffer", size: 3_200, kind: "bss" },
    { name: "strip", size: 1_104, kind: "data" },
    { name: "setup()", size: 612, kind: "code" },
  ],
};

const BOARDS: BoardEntry[] = [
  { name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3", platform: "esp32:esp32" },
  { name: "ESP32 Dev Module", fqbn: "esp32:esp32:esp32", platform: "esp32:esp32" },
  { name: "ESP32S2 Dev Module", fqbn: "esp32:esp32:esp32s2", platform: "esp32:esp32" },
  { name: "ESP32C3 Dev Module", fqbn: "esp32:esp32:esp32c3", platform: "esp32:esp32" },
  { name: "ESP32C6 Dev Module", fqbn: "esp32:esp32:esp32c6", platform: "esp32:esp32" },
  { name: "ESP32-S3-Box", fqbn: "esp32:esp32:esp32s3box", platform: "esp32:esp32" },
  { name: "XIAO_ESP32S3", fqbn: "esp32:esp32:XIAO_ESP32S3", platform: "esp32:esp32" },
  { name: "Arduino Uno", fqbn: "arduino:avr:uno", platform: "arduino:avr" },
];

const OPTIONS: BoardOption[] = [
  { id: "FlashSize", label: "Flash Size", default: "4M", values: ["4M", "8M", "16M", "32M"].map((v) => ({ value: v, label: `${v.replace("M", "")}MB (${Number(v.replace("M", "")) * 8}Mb)` })) },
  { id: "PartitionScheme", label: "Partition Scheme", default: "default", values: [{ value: "default", label: "Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)" }, { value: "default_16MB", label: "16M Flash (3MB APP/9.9MB FATFS)" }, { value: "huge_app", label: "Huge APP (3MB No OTA/1MB SPIFFS)" }] },
  { id: "PSRAM", label: "PSRAM", default: "disabled", values: [{ value: "disabled", label: "Disabled" }, { value: "enabled", label: "QSPI PSRAM" }, { value: "opi", label: "OPI PSRAM" }] },
  { id: "CDCOnBoot", label: "USB CDC On Boot", default: "default", values: [{ value: "default", label: "Disabled" }, { value: "cdc", label: "Enabled" }] },
  { id: "UploadSpeed", label: "Upload Speed", default: "921600", values: ["921600", "460800", "230400", "115200"].map((v) => ({ value: v, label: v })) },
];

const LIBS: LibraryInfo[] = [
  { name: "Adafruit NeoPixel", version: "1.12.3", author: "Adafruit", sentence: "Steuert WS2812-LEDs und kompatible Streifen.", website: "https://github.com/adafruit/Adafruit_NeoPixel", location: "user", providesIncludes: ["Adafruit_NeoPixel.h"], latest: null },
  { name: "ArduinoJson", version: "7.0.4", author: "Benoit Blanchon", sentence: "JSON-Bibliothek für eingebettete Systeme.", website: "https://arduinojson.org", location: "user", providesIncludes: ["ArduinoJson.h"], latest: "7.2.1" },
  { name: "NimBLE-Arduino", version: "2.5.1", author: "h2zero", sentence: "Bluetooth Low Energy für ESP32.", website: "https://github.com/h2zero/NimBLE-Arduino", location: "user", providesIncludes: ["NimBLEDevice.h"], latest: "2.6.0" },
];

const CATALOG: LibrarySearchHit[] = [
  { name: "Adafruit NeoPixel", latest: "1.12.3", author: "Adafruit", sentence: "Steuert WS2812-LEDs und kompatible Streifen.", website: "", versions: ["1.12.3", "1.12.2", "1.11.0"], installed: "1.12.3" },
  { name: "FastLED", latest: "3.9.4", author: "Daniel Garcia", sentence: "Schnelle LED-Bibliothek für viele Chips.", website: "", versions: ["3.9.4", "3.9.0"], installed: null },
  { name: "PubSubClient", latest: "2.8.0", author: "Nick O'Leary", sentence: "MQTT-Client für Arduino.", website: "", versions: ["2.8.0"], installed: null },
  { name: "ArduinoJson", latest: "7.2.1", author: "Benoit Blanchon", sentence: "JSON-Bibliothek für eingebettete Systeme.", website: "", versions: ["7.2.1", "7.0.4"], installed: "7.0.4" },
  { name: "Adafruit BME280 Library", latest: "2.2.4", author: "Adafruit", sentence: "Temperatur, Luftdruck und Feuchte über I2C oder SPI.", website: "", versions: ["2.2.4"], installed: null },
];

/** Prüfung im Mock: Zeilen, die wie ein Aufruf aussehen, aber ohne `;` vor einer schließenden Klammer stehen. */
function mockCheck(files: Record<string, string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!/\.(ino|cpp|c)$/i.test(file)) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
      if (/^\s+[\w.:]+\(.*\)\s*$/.test(line) && next.trim().startsWith("}")) {
        const col = line.trimEnd().length;
        out.push({
          id: `compiler:${file}:${i + 1}:${col}`,
          file,
          line: i + 1,
          from: col - 1,
          to: col,
          severity: "error",
          message: "Semikolon erwartet vor „}“",
          source: "compiler",
          fix: { label: "„;“ einfügen", edits: [{ fromLine: i + 1, fromCol: col, toLine: i + 1, toCol: col, text: ";" }] },
        });
      }
    });
  }
  return out;
}

function hashOf(files: Record<string, string>): string {
  let h = 5381;
  for (const t of Object.values(files)) for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export interface MockControl {
  setDevices(list: DeviceInfo[]): void;
  /** Bis zum Aufruf liegt kein Board am USB. */
  plug(): void;
  unplug(): void;
  /** Was per „Speichern unter“ geschrieben wurde, nach Dateiname. */
  exported: Map<string, string>;
}

type HardwareApi = Pick<
  Backend,
  | "toolchainStatus"
  | "toolchainSetup"
  | "toolchainSetupNrf"
  | "onToolchainProgress"
  | "boards"
  | "boardOptions"
  | "syntax"
  | "check"
  | "analyze"
  | "build"
  | "cancelBuild"
  | "flash"
  | "onBuildEvent"
  | "devices"
  | "onDevicesChanged"
  | "probeDevice"
  | "monitorStart"
  | "monitorStop"
  | "monitorWrite"
  | "onMonitorLines"
  | "onMonitorState"
  | "libraries"
  | "searchLibraries"
  | "installLibrary"
  | "uninstallLibrary"
  | "upgradeLibrary"
  | "onLibraryProgress"
  | "secrets"
  | "setSecret"
  | "removeSecret"
  | "search"
  | "lspSync"
  | "lspComplete"
  | "lspHover"
  | "lspDefinition"
  | "lspSignature"
  | "lspTokens"
  | "readExternal"
  | "fbuildStatus"
  | "fbuildInstall"
  | "fbuildSetEnabled"
  | "mcpStatus"
  | "mcpSetEnabled"
  | "mcpConnect"
  | "mcpOpenInClaude"
  | "aiState"
  | "aiConfigure"
  | "aiSetProjectEnabled"
  | "aiModels"
  | "aiCheck"
  | "onAiBlock"
  | "aiThreads"
  | "aiThreadReply"
  | "aiThreadClose"
  | "aiThreadReopen"
  | "aiFix"
  | "aiTask"
  | "examples"
  | "coreUpgrade"
  | "refreshIndexIfStale"
  | "outdatedLibraries"
  | "pickLibraryZip"
  | "installLibraryZip"
  | "memoryDetail"
  | "otaPasswordSet"
  | "setOtaPassword"
  | "saveTextAs"
  | "monitorReset"
  | "monitorSetBaud"
  | "decodeBacktrace"
>;

const BOOT_LOG = [
  "ets Jul 29 2019 12:21:46",
  "rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)",
  "I (29) boot: ESP-IDF v5.1.2 2nd stage bootloader",
  "I (312) wifi: Verbunden mit Heimnetz, IP 192.168.1.42",
];

/** Ein Absturz, wie ihn ein ESP32 meldet. */
const CRASH_LOG = [
  "Guru Meditation Error: Core  1 panic'ed (LoadProhibited). Exception was unhandled.",
  "Core  1 register dump:",
  "PC      : 0x400d1234  PS      : 0x00060b30  A0      : 0x800d1288  A1      : 0x3ffb1f50",
  "EXCVADDR: 0x00000000  LBEG    : 0x4008a1c4",
  "Backtrace: 0x400d1234:0x3ffb1f50 0x400d1288:0x3ffb1f70 0x400d5678:0x3ffb1f90",
];

export function createMockHardware(readProject: () => Record<string, string>, opts: { devicesAtStart?: boolean; speed?: number; secretNames?: string[] } = {}): { api: HardwareApi; control: MockControl } {
  const speed = opts.speed ?? 1;
  const toolchain = new Emitter<ToolchainProgress>();
  const buildEvents = new Emitter<BuildEvent>();
  const devicesEv = new Emitter<DeviceInfo[]>();
  const lines = new Emitter<MonitorLine[]>();
  const mstate = new Emitter<MonitorState>();
  const libProgress = new Emitter<LibraryProgress>();

  let devices: DeviceInfo[] = opts.devicesAtStart === false ? [] : [MOCK_DEVICE, MOCK_NET_DEVICE];
  const core = { installed: "3.2.0", latest: "3.3.12" };
  const otaPasswords = new Set<string>();
  let lastBuildHash = "";
  const flashed = new Map<string, string>();
  let installed = [...LIBS];
  const fb = { installed: false, enabled: true };
  const mcp = { enabled: false, connected: false };
  const aiEv = new Emitter<AiBlockResult>();
  const threads = new Map<string, AiThread>();
  const ai = { key: "", model: "", dailyTokens: 50_000, used: 0, enabled: true };
  const secretStore = new Map<string, { value: string; global: boolean }>();
  const declared = new Set<string>(opts.secretNames ?? []);
  let cancelled = false;
  const exported = new Map<string, string>();
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let lineId = 0;
  let started = 0;

  const emitCrash = () => {
    for (const text of CRASH_LOG) lines.emit([{ id: ++lineId, t: Date.now() - started, kind: text.startsWith("Guru") ? "err" : "rx", text }]);
  };

  const setDevices = (list: DeviceInfo[]) => {
    devices = list;
    devicesEv.emit(list);
  };

  const phase = (stage: number, progress: number, detail: string) => buildEvents.emit({ kind: "phase", stage, progress, detail });
  const out = (line: string, level: "info" | "cmd" | "warn" | "err" = "info") => buildEvents.emit({ kind: "output", line, level });

  async function build(force: boolean): Promise<BuildOutcome> {
    cancelled = false;
    const files = readProject();
    const hash = hashOf(files);
    const base = { hash, buildDir: "/cache/build", partitions: [], diagnostics: [] as Diagnostic[], error: null };
    phase(0, 0, "Prüfe Quelltext");
    await sleep(150 * speed);
    const diags = mockCheck(files);
    if (diags.length) {
      out(`${diags.length} Fehler im Quelltext. Der Build wurde nicht gestartet.`, "err");
      return { ...base, status: "failed", durationMs: 160, sizes: [], diagnostics: diags };
    }
    const sizes = [
      { label: "Flash", used: 288_462, total: 1_310_720 },
      { label: "RAM", used: 22_128, total: 327_680 },
    ];
    const partitions = [
      { name: "nvs", type: "data", subtype: "nvs", offset: 0x9000, size: 0x5000 },
      { name: "app0", type: "app", subtype: "ota_0", offset: 0x10000, size: 0x140000 },
      { name: "spiffs", type: "data", subtype: "spiffs", offset: 0x150000, size: 0xb0000 },
    ];
    if (hash === lastBuildHash && !force) {
      out("Unverändert. Der letzte Build wird verwendet.");
      phase(1, 1, "Unverändert");
      return { ...base, status: "skipped", durationMs: 12, sizes, partitions };
    }
    for (let i = 1; i <= 20; i++) {
      if (cancelled) throw new Error("Abgebrochen.");
      phase(0, i / 20, "Kompiliere");
      if (i % 4 === 0) out(`Kompiliere Datei ${i}.cpp`, "cmd");
      await sleep(70 * speed);
    }
    phase(1, 0.4, "Linke");
    await sleep(250 * speed);
    phase(1, 1, "Fertig");
    out("Sketch uses 288462 bytes (22%) of program storage space. Maximum is 1310720 bytes.");
    lastBuildHash = hash;
    return { ...base, status: "built", durationMs: 1900, sizes, partitions };
  }

  async function flashOverNetwork(args: Parameters<Backend["flash"]>[0]): Promise<FlashResult> {
    const outcome = await build(false);
    if (outcome.status === "failed") return { status: "buildFailed", build: outcome } as FlashResult;
    const key = args.deviceId;
    if (key && !args.force && flashed.get(key) === outcome.hash) return { status: "alreadyCurrent", build: outcome };
    if (devices.find((d) => d.id === key)?.auth && !otaPasswords.has(key ?? "")) throw new Error("Das Gerät verlangt ein OTA-Passwort. Trage es im Geräte-Bereich ein.");
    phase(2, 0.3, "Verbinde");
    out(`Übertrage an ${args.target?.kind === "network" ? `${args.target.host}:${args.target.port}` : ""}`);
    await sleep(300 * speed);
    phase(2, 1, "Verbunden");
    phase(3, 1, "Kein Löschen nötig");
    for (let p = 0; p <= 20; p++) {
      if (cancelled) throw new Error("Abgebrochen.");
      phase(4, p / 20, "Schreibe");
      await sleep(70 * speed);
    }
    phase(5, 1, "Neustart");
    if (key) flashed.set(key, outcome.hash);
    return { status: "flashed", build: outcome, flash: { durationMs: 6100, bytes: 288_462, chip: null, mac: null } };
  }

  const api: HardwareApi = {
    toolchainStatus: async () => ({ arduinoCli: "1.5.1", esp32Core: core.installed, esptool: true, error: null, esp32CoreLatest: core.latest }),
    toolchainSetupNrf: async () => {
      toolchain.emit({ line: "Installiere Seeed-nRF52-Core", fraction: null });
      await sleep(200 * speed);
    },
    toolchainSetup: async () => {
      for (const [i, l] of ["Trage Espressif-Quelle ein", "Lade Paketliste", "Installiere ESP32-Core"].entries()) {
        toolchain.emit({ line: l, fraction: null });
        await sleep(200 * speed);
        if (i === 2) for (let p = 0; p <= 10; p++) (toolchain.emit({ line: "esp32:esp32@3.3.12 wird geladen", fraction: p / 10 }), await sleep(80 * speed));
      }
    },
    onToolchainProgress: toolchain.on,
    boards: async () => BOARDS,
    boardOptions: async (fqbn) => (fqbn.startsWith("esp32:") ? OPTIONS : []),

    syntax: async () => [],
    check: async (_b, overrides) => {
      await sleep(120 * speed);
      return { ran: true, diagnostics: mockCheck({ ...readProject(), ...overrides }), note: null, durationMs: 640 };
    },

    analyze: async () => ({ diagnostics: [], facts: [] }),

    build: (_b, force) => build(force),
    cancelBuild: async () => void (cancelled = true),
    flash: async (args) => {
      if (args.target?.kind === "network") return flashOverNetwork(args);
      const outcome = await build(false);
      if (outcome.status === "failed") return { status: "buildFailed", build: outcome } as FlashResult;
      const usedNames = [...Object.values(readProject()).join("\n").matchAll(/Secret\("([A-Za-z0-9_]{1,15})"\)/g)].map((m) => m[1]);
      const needed = [...new Set([...usedNames, ...declared])];
      const missing = needed.filter((n) => !secretStore.has(n));
      if (missing.length) return { status: "secretsMissing", names: missing };
      const key = args.deviceId;
      if (key && !args.force && flashed.get(key) === outcome.hash) return { status: "alreadyCurrent", build: outcome };
      phase(2, 0.3, "Verbinde");
      out("Connecting....");
      await sleep(300 * speed);
      phase(2, 1, "Verbunden");
      phase(3, 1, "Kein Löschen nötig");
      out("Chip type: ESP32-S3 (QFN56) (revision v0.2)");
      for (let p = 0; p <= 20; p++) {
        if (cancelled) throw new Error("Abgebrochen.");
        phase(4, p / 20, "Schreibe");
        if (p % 5 === 0) out(`Writing at 0x${(0x10000 + p * 4096).toString(16).padStart(8, "0")}... (${p * 5} %)`);
        await sleep(90 * speed);
      }
      phase(5, 1, "Neustart");
      out("Hard resetting via RTS pin...");
      if (key) flashed.set(key, outcome.hash);
      return { status: "flashed", build: outcome, flash: { durationMs: 8400, bytes: 742_000, chip: "ESP32-S3", mac: MOCK_DEVICE.mac } };
    },
    onBuildEvent: buildEvents.on,

    devices: async () => devices,
    onDevicesChanged: devicesEv.on,
    probeDevice: async () => ({ chip: "ESP32-S3", mac: MOCK_DEVICE.mac }),
    monitorStart: async () => {
      if (monitorTimer) clearInterval(monitorTimer);
      started = Date.now();
      mstate.emit({ state: "connecting" });
      await sleep(80 * speed);
      mstate.emit({ state: "connected" });
      setTimeout(() => monitorTimer && emitCrash(), 1500 * speed);
      monitorTimer = setInterval(() => {
        const x = Date.now() / 1000;
        const volts = 1.65 + Math.sin(x * 1.3) * 0.9 + Math.sin(x * 4.1) * 0.18 + (Math.random() - 0.5) * 0.12;
        const raw = Math.round((volts / 3.3) * 4095);
        lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "rx", text: `raw:${raw} volts:${volts.toFixed(2)}` }]);
        const temp = 23 + Math.sin(x / 3) * 1.5;
        const hum = 51 + Math.cos(x / 5) * 6;
        lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "rx", text: `temp:${temp.toFixed(1)} hum:${hum.toFixed(1)} light:${Math.round(800 + Math.sin(x) * 60)} pres:${(1013 + Math.sin(x / 9) * 2).toFixed(1)} gyro:${(Math.sin(x * 2) * 3).toFixed(2)} tilt:${(Math.cos(x * 1.7) * 8).toFixed(1)}` }]);
      }, 120);
    },
    monitorStop: async () => {
      if (monitorTimer) clearInterval(monitorTimer);
      monitorTimer = null;
      mstate.emit({ state: "closed" });
    },
    monitorWrite: async (text) => {
      lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "tx", text }]);
      if (text.trim() === "crash") emitCrash();
      if (text.trim() === "disconnect") {
        // Wie ein gezogenes Kabel: Der Monitor meldet den Grund und verbindet sich nach kurzer Zeit neu.
        mstate.emit({ state: "reconnecting", reason: "Verbindung verloren" });
        setTimeout(() => {
          if (!monitorTimer) return;
          mstate.emit({ state: "connected" });
          lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "sys", text: "Verbindung wiederhergestellt." }]);
        }, 2500 * speed);
      }
    },
    onMonitorLines: lines.on,
    onMonitorState: mstate.on,

    libraries: async () => installed,
    searchLibraries: async (q) => CATALOG.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())).map((l) => ({ ...l, installed: installed.find((i) => i.name === l.name)?.version ?? null })),
    installLibrary: async (name, version) => {
      for (let p = 0; p <= 5; p++) (libProgress.emit({ name, line: `${name} wird geladen`, fraction: p / 5 }), await sleep(90 * speed));
      const hit = CATALOG.find((l) => l.name === name);
      installed = [...installed.filter((i) => i.name !== name), { name, version: version ?? hit?.latest ?? "1.0.0", author: hit?.author ?? "", sentence: hit?.sentence ?? "", website: "", location: "user", providesIncludes: [], latest: null }];
    },
    uninstallLibrary: async (name) => void (installed = installed.filter((i) => i.name !== name)),
    upgradeLibrary: async (name) => {
      const hit = CATALOG.find((l) => l.name === name);
      installed = installed.map((i) => (i.name === name ? { ...i, version: i.latest ?? hit?.latest ?? i.version, latest: null } : i));
    },
    onLibraryProgress: libProgress.on,
    outdatedLibraries: async (): Promise<OutdatedItem[]> => installed.filter((i) => i.latest).map((i) => ({ name: i.name, installed: i.version, latest: i.latest! })),
    pickLibraryZip: async () => "/Users/demo/Downloads/Ultraschall-Sensor-1.2.0.zip",
    installLibraryZip: async (path) => {
      const name = (path.split("/").pop() ?? "Bibliothek").replace(/\.zip$/i, "").replace(/-\d+(\.\d+)*$/, "");
      for (let p = 0; p <= 5; p++) (libProgress.emit({ name, line: `${name} wird entpackt`, fraction: p / 5 }), await sleep(90 * speed));
      installed = [...installed.filter((i) => i.name !== name), { name, version: "1.2.0", author: "", sentence: "Aus ZIP-Datei installiert.", website: "", location: "user", providesIncludes: [], latest: null }];
    },
    examples: async (fqbn) => (fqbn && !fqbn.startsWith("esp32:") ? [] : MOCK_EXAMPLES),
    coreUpgrade: async () => {
      for (let p = 0; p <= 10; p++) (toolchain.emit({ line: `esp32:esp32@${core.latest} wird geladen`, fraction: p / 10 }), await sleep(80 * speed));
      core.installed = core.latest;
    },
    refreshIndexIfStale: async () => false,
    memoryDetail: async () => {
      if (!lastBuildHash) throw new Error("Es gibt noch keinen Build. Kompiliere zuerst.");
      await sleep(120 * speed);
      return MOCK_MEMORY;
    },
    otaPasswordSet: async (id) => otaPasswords.has(id),
    setOtaPassword: async (id, password) => void (password ? otaPasswords.add(id) : otaPasswords.delete(id)),
    monitorReset: async () => {
      if (!monitorTimer) throw new Error("Der Monitor ist nicht verbunden.");
      lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "sys", text: "Board wird neu gestartet." }]);
      for (const text of BOOT_LOG) lines.emit([{ id: ++lineId, t: Date.now() - started, kind: text.startsWith("E (") ? "err" : "rx", text }]);
    },
    monitorSetBaud: async (baud) => {
      lines.emit([{ id: ++lineId, t: Date.now() - started, kind: "sys", text: `Baudrate: ${baud}` }]);
    },
    decodeBacktrace: async (text) => {
      if (!/0x[0-9a-f]+/i.test(text)) throw new Error("In dieser Zeile stehen keine Adressen.");
      if (!lastBuildHash) throw new Error("Es gibt noch keinen Build. Kompiliere zuerst, damit die ELF-Datei zum Board passt.");
      const main = Object.keys(readProject()).find((p) => p.endsWith(".ino")) ?? "";
      const frames: BacktraceFrame[] = [
        { addr: "0x400d1234", function: "readSensor()", file: main, line: 18 },
        { addr: "0x400d1288", function: "loop()", file: main, line: 31 },
        { addr: "0x400d5678", function: "loopTask(void*)", file: "/Users/mock/.arduino15/packages/esp32/hardware/esp32/3.2.0/cores/esp32/main.cpp", line: 74 },
      ];
      return frames;
    },
    saveTextAs: async (name, text) => {
      exported.set(name, text);
      return `/Users/mock/Downloads/${name}`;
    },

    search: async (query: string, o: SearchOptions, overrides: Record<string, string>): Promise<SearchResult> => {
      if (!query) return { hits: [], truncated: false };
      let re: RegExp;
      try {
        const body = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        re = new RegExp(o.wholeWord ? `\\b(?:${body})\\b` : body, o.caseSensitive ? "g" : "gi");
      } catch {
        throw new Error("Der Ausdruck ist ungültig.");
      }
      const hits: SearchResult["hits"] = [];
      for (const [file, text] of Object.entries({ ...readProject(), ...overrides })) {
        text.split("\n").forEach((line, i) => {
          for (const m of line.matchAll(re)) if (m[0]) hits.push({ file, line: i + 1, col: m.index ?? 0, endCol: (m.index ?? 0) + m[0].length, text: line.slice(0, 300) });
        });
      }
      return { hits, truncated: false };
    },
    lspSync: async () => false,
    lspComplete: async () => [],
    lspHover: async () => null,
    lspDefinition: async () => [],
    lspSignature: async () => null,
    lspTokens: async () => null,
    readExternal: async () => {
      throw new Error("Im Vorschaumodus gibt es keine Bibliotheksdateien.");
    },
    fbuildStatus: async (): Promise<FbuildStatus> => ({ installed: fb.installed, version: fb.installed ? "2.5.44" : null, enabled: fb.enabled, boards: ["ESP32 Dev Module"] }),
    fbuildInstall: async () => {
      await sleep(800 * speed);
      fb.installed = true;
    },
    fbuildSetEnabled: async (enabled) => void (fb.enabled = enabled),
    mcpStatus: async (): Promise<McpStatus> => ({ enabled: mcp.enabled, running: mcp.enabled, port: mcp.enabled ? 47615 : null, connected: mcp.connected }),
    mcpSetEnabled: async (enabled) => void (mcp.enabled = enabled),
    mcpConnect: async () => {
      mcp.enabled = true;
      mcp.connected = true;
    },
    mcpOpenInClaude: async () => undefined,
    aiState: async (): Promise<AiState> => ({ hasKey: !!ai.key, model: ai.model || "deepseek/deepseek-v4-flash", modelIsDefault: !ai.model, dailyTokens: ai.dailyTokens, usedToday: ai.used, projectEnabled: ai.enabled }),
    aiConfigure: async (o) => {
      if (o.key !== undefined) ai.key = o.key;
      if (o.model !== undefined) ai.model = o.model;
      if (o.dailyTokens !== undefined) ai.dailyTokens = o.dailyTokens;
    },
    aiSetProjectEnabled: async (enabled) => void (ai.enabled = enabled),
    aiModels: async (): Promise<ModelList> => ({
      suggested: "deepseek/deepseek-v4-flash",
      models: [
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: V4 Flash", promptPrice: 0.15, completionPrice: 0.6, context: 128000, supportsJson: true },
        { id: "google/gemini-2.0-flash-001", name: "Google: Gemini 2.0 Flash", promptPrice: 0.1, completionPrice: 0.4, context: 1000000, supportsJson: true },
      ],
    }),
    aiCheck: async (_b, overrides): Promise<AiRun> => {
      if (!ai.key) return { summary: { calls: 0, cached: 0, tokens: 0, stopped: null }, blocks: [], skipped: "noKey" };
      const files = { ...readProject(), ...overrides };
      const found: Array<[string, string]> = [];
      for (const [file, text] of Object.entries(files)) {
        if (!file.endsWith(".ino")) continue;
        const lines = text.split("\n");
        lines.forEach((line, i) => {
          const m = /^(?:void|int|float|bool|String)\s+(\w+)\([^)]*\)\s*\{/.exec(line);
          if (!m) return;
          let depth = 0;
          let end = i;
          for (let j = i; j < lines.length; j++) {
            depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
            if (depth === 0) {
              end = j;
              break;
            }
          }
          if (end - i < 3) return;
          found.push([file, m[1]]);
          void (async () => {
            await sleep(500 * speed);
            const bad = lines.slice(i, end + 1).findIndex((l) => /i\s*<=\s*\w+/.test(l));
            const lineText = bad >= 0 ? lines[i + bad].trim().replace(/\s+/g, " ") : "";
            const threadId = `t${[...lineText].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
            const known = threads.get(threadId);
            if (bad >= 0 && !known) {
              const message = "Die Schleife läuft einmal zu weit und greift hinter das Ende des Arrays.";
              const now = Math.floor(Date.now() / 1000);
              threads.set(threadId, { id: threadId, function: m[1], lineText, severity: "warning", status: "open", messages: [{ role: "ai", text: message, at: now }], createdAt: now, updatedAt: now });
            }
            const diagnostics: Diagnostic[] =
              bad >= 0 && known?.status !== "closed"
                ? [{ id: `ai:${threadId}`, file, line: i + bad + 1, from: 2, to: lines[i + bad].length, severity: "warning", message: "Die Schleife läuft einmal zu weit und greift hinter das Ende des Arrays.", source: "ai", fix: { label: "Vorschlag übernehmen", edits: [{ fromLine: i + bad + 1, fromCol: lines[i + bad].indexOf("<="), toLine: i + bad + 1, toCol: lines[i + bad].indexOf("<=") + 2, text: "<" }] } }]
                : [];
            ai.used += 900;
            aiEv.emit({ file, name: m[1], startLine: i + 1, endLine: end + 1, state: bad >= 0 ? "issues" : "ok", message: null, diagnostics, cached: false });
          })();
        });
      }
      await sleep(700 * speed);
      return { summary: { calls: found.length, cached: 0, tokens: found.length * 900, stopped: null }, blocks: found, skipped: null };
    },
    onAiBlock: aiEv.on,
    aiThreads: async () => [...threads.values()].map((t) => structuredClone(t)),
    aiThreadReply: async (_b, _o, id, text) => {
      const t = threads.get(id);
      if (!t) throw new Error("Das Gespräch gibt es nicht mehr.");
      await sleep(600 * speed);
      const now = Math.floor(Date.now() / 1000);
      t.messages.push({ role: "user", text, at: now });
      const intended = /absicht|gewollt|so gewollt/i.test(text);
      t.messages.push({
        role: "ai",
        text: intended ? "Verstanden, mit der Erklärung ist das richtig so. Ich melde es nicht mehr." : "Bei i = 8 liest die Schleife hinter das Array. Das Array hat nur die Indizes 0 bis 7.",
        at: now,
      });
      if (intended) Object.assign(t, { status: "closed", resolution: "accepted" });
      t.updatedAt = now;
      return { thread: structuredClone(t), tokens: 400 };
    },
    aiThreadClose: async (id) => {
      const t = threads.get(id);
      if (!t) throw new Error("Das Gespräch gibt es nicht mehr.");
      Object.assign(t, { status: "closed", resolution: "dismissed", updatedAt: Math.floor(Date.now() / 1000) });
      return structuredClone(t);
    },
    aiTask: async (_b, overrides, task, active) => {
      await sleep(900 * speed);
      const file = active ?? Object.keys(readProject())[0];
      const text = overrides[file] ?? readProject()[file] ?? "";
      const lines = text.split("\n");
      const setup = lines.findIndex((l) => /void\s+setup\s*\(\s*\)/.test(l));
      if (!file || setup < 0) return { changes: [], created: [], note: "Dazu brauche ich einen Sketch mit setup().", tokens: 500 };
      const eol = lines[setup].length;
      return {
        changes: [{ file, edits: [{ fromLine: setup + 1, fromCol: eol, toLine: setup + 1, toCol: eol, text: `\n  // Aufgabe: ${task.trim().split("\n")[0].slice(0, 60)}\n  Serial.begin(115200);` }] }],
        created: [],
        note: "Ich habe die serielle Schnittstelle in setup() gestartet.",
        tokens: 500,
      };
    },
    aiFix: async (_b, overrides, file, line, _message) => {
      await sleep(600 * speed);
      const text = overrides[file] ?? readProject()[file] ?? "";
      const at = text.split("\n")[line - 1]?.indexOf("<=") ?? -1;
      if (at < 0) return { edits: [], note: "Dafür müsste ich nachfragen.", tokens: 300 };
      return { edits: [{ fromLine: line, fromCol: at, toLine: line, toCol: at + 2, text: "<" }], note: "Die Schleife läuft jetzt bis SIZE - 1.", tokens: 300 };
    },
    aiThreadReopen: async (id) => {
      const t = threads.get(id);
      if (!t) throw new Error("Das Gespräch gibt es nicht mehr.");
      t.status = "open";
      delete t.resolution;
      return structuredClone(t);
    },

    secrets: async () => {
      const used = new Set([...Object.values(readProject()).join("\n").matchAll(/Secret\("([A-Za-z0-9_]{1,15})"\)/g)].map((m) => m[1]));
      return [...new Set([...declared, ...used])].sort().map((name): SecretStatus => ({ name, set: secretStore.has(name), scope: secretStore.has(name) ? (secretStore.get(name)!.global ? "global" : "project") : null, used: used.has(name) }));
    },
    setSecret: async (name, value, global) => {
      declared.add(name);
      secretStore.set(name, { value, global });
    },
    removeSecret: async (name) => {
      secretStore.delete(name);
      declared.delete(name);
    },
  };

  return { api, control: { setDevices, plug: () => setDevices([MOCK_DEVICE]), unplug: () => setDevices([]), exported } };
}
