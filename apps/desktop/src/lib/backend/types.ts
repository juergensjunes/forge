import type { Diagnostic, TextEdit } from "../diagnostics";

export type ProjectKind = "project" | "sketch";
export type TemplateId = "blank" | "blink" | "wifi" | "webserver";

export interface ForgeConfig {
  project: { name: string; description?: string };
  board: { fqbn: string; options: Record<string, string> };
  libraries: Record<string, string>;
  secrets: { names: string[] };
  ai: { enabled: boolean };
}

export interface ProjectInfo {
  kind: ProjectKind;
  name: string;
  path: string;
  mainFile: string;
  config: ForgeConfig;
  /** Die .forgeproj-Datei, in der das Projekt gespeichert wird. `path` ist dann der Arbeitsordner. */
  package?: string;
}

/** Was auf diesem Rechner fehlt, damit ein geöffnetes .forgeproj so baut wie beim Absender. */
export interface PackageNeeds {
  libraries: PackageNeed[];
  core: { id: string; wanted: string; installed: string | null } | null;
}

export interface PackageNeed {
  name: string;
  version: string;
  /** `registry`: aus dem Bibliotheksverwalter, `embedded`: steckt in der Projektdatei. */
  source: "registry" | "embedded";
  /** Eine andere, bereits installierte Version. Forge ersetzt sie nicht von selbst. */
  installed: string | null;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

export interface CreateProjectRequest {
  name: string;
  parent: string;
  fqbn: string;
  template: TemplateId;
  description?: string;
  git: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  kind: ProjectKind;
  openedAt: number;
}

/* ---------- Gespräche über Hinweise der KI ---------- */
export interface AiThreadMessage {
  role: "ai" | "user";
  text: string;
  /** Sekunden seit 1970. */
  at: number;
}

export interface AiThread {
  /** Wie die Kennung des Hinweises im Editor, ohne das „ai:“ davor. */
  id: string;
  function: string;
  lineText: string;
  severity: "warning" | "info";
  status: "open" | "closed";
  /** `accepted`: die KI hat die Erklärung akzeptiert. `dismissed`: der Nutzer hat geschlossen. `fixed`: die Zeile wurde geändert. */
  resolution?: "accepted" | "dismissed" | "fixed";
  messages: AiThreadMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Was die KI zur Behebung eines Hinweises vorschlägt. Ohne Änderungen steht in `note`, warum nicht. */
export interface AiFix {
  edits: TextEdit[];
  note: string;
  tokens: number;
}

/** Was die KI für eine Aufgabe vorschlägt: Änderungen je Datei und neue Dateien. */
export interface AiTaskResult {
  changes: Array<{ file: string; edits: TextEdit[] }>;
  created: Array<{ file: string; text: string }>;
  note: string;
  tokens: number;
}

export interface AiThreadReply {
  thread: AiThread;
  tokens: number;
}

/* ---------- Toolchain, Boards ---------- */
export interface ToolchainStatus {
  arduinoCli: string | null;
  esp32Core: string | null;
  esptool: boolean;
  error: string | null;
  /** Neueste Version des ESP32-Cores laut Paketliste. */
  esp32CoreLatest?: string | null;
  /** Installierter Seeed-nRF52-Core (XIAO nRF52840). */
  nrf52Core?: string | null;
}

export interface ToolchainProgress {
  line: string;
  fraction: number | null;
}

export interface BoardEntry {
  name: string;
  fqbn: string;
  platform: string;
}

export interface BoardOptionValue {
  value: string;
  label: string;
}

export interface BoardOption {
  id: string;
  label: string;
  values: BoardOptionValue[];
  default: string;
}

export interface BoardArg {
  fqbn: string;
  options: Record<string, string>;
}

/* ---------- Geräte ---------- */
export type Bridge = "esp-native" | "cp210x" | "ch340" | "ch9102" | "ftdi" | "nrf52" | "network" | "other";

export interface DeviceInfo {
  id: string;
  port: string;
  vid: number;
  pid: number;
  serial: string | null;
  product: string | null;
  manufacturer: string | null;
  bridge: Bridge;
  label: string;
  likelyEsp: boolean;
  mac: string | null;
  /** Fehlt bei älteren Mocks: dann USB. */
  transport?: "usb" | "network";
  /** Adresse und OTA-Port eines Boards im WLAN. */
  host?: string | null;
  otaPort?: number | null;
  /** Das Board im WLAN verlangt ein OTA-Passwort. */
  auth?: boolean;
}

export interface ChipProbe {
  chip: string;
  mac: string | null;
}

/* ---------- Prüfung, Build, Flash ---------- */
export interface CheckOutput {
  ran: boolean;
  diagnostics: Diagnostic[];
  note: string | null;
  durationMs: number;
}

export type BuildEvent =
  | { kind: "phase"; stage: number; progress: number; detail: string }
  | { kind: "output"; line: string; level: "info" | "cmd" | "warn" | "err" };

export interface SizeInfo {
  label: string;
  used: number;
  total: number;
}

export interface PartitionInfo {
  name: string;
  type: string;
  subtype: string;
  offset: number;
  size: number;
}

export interface BuildOutcome {
  status: "built" | "skipped" | "failed";
  hash: string;
  durationMs: number;
  sizes: SizeInfo[];
  partitions: PartitionInfo[];
  buildDir: string;
  diagnostics: Diagnostic[];
  error: string | null;
}

export interface FlashOutcome {
  durationMs: number;
  bytes: number;
  chip: string | null;
  mac: string | null;
}

export type FlashResult =
  | { status: "flashed"; build: BuildOutcome; flash: FlashOutcome }
  | { status: "alreadyCurrent"; build: BuildOutcome }
  | { status: "buildFailed"; build: BuildOutcome }
  | { status: "secretsMissing"; names: string[] };

export interface FlashArgs {
  board: BoardArg;
  port: string;
  deviceId: string | null;
  eraseAll: boolean;
  force: boolean;
  /** Ohne Angabe wird seriell über `port` geflasht. */
  target?: FlashTarget;
}

export type FlashTarget = { kind: "serial"; port: string } | { kind: "network"; host: string; port: number };

/* ---------- Monitor ---------- */
export interface MonitorLine {
  id: number;
  t: number;
  kind: "rx" | "tx" | "sys" | "err";
  text: string;
}

export type MonitorState = { state: "connecting" | "connected" | "closed" } | { state: "reconnecting"; reason: string };

/* ---------- Bibliotheken ---------- */
export interface LibraryInfo {
  name: string;
  version: string;
  author: string;
  sentence: string;
  website: string;
  location: string;
  providesIncludes: string[];
  latest: string | null;
}

export interface LibrarySearchHit {
  name: string;
  latest: string;
  author: string;
  sentence: string;
  website: string;
  versions: string[];
  installed: string | null;
}

export interface LibraryProgress {
  name: string;
  line: string;
  fraction: number | null;
}

/* ---------- Statische Analyse ---------- */
export interface FunctionFacts {
  file: string;
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  hash: string;
  /** setup, loop, isr, task, callback oder unreachable */
  contexts: string[];
  callers: string[];
  callees: string[];
  references: number;
  globalsUsed: string[];
  pins: number[];
}

export interface AnalysisOutput {
  diagnostics: Diagnostic[];
  facts: FunctionFacts[];
}

/* ---------- Secrets ---------- */
export interface SecretStatus {
  name: string;
  set: boolean;
  scope: "project" | "global" | null;
  /** Der Code liest dieses Secret mit Secret("...") */
  used: boolean;
}

/* ---------- KI-Prüfung ---------- */
export interface AiState {
  hasKey: boolean;
  model: string;
  modelIsDefault: boolean;
  dailyTokens: number;
  usedToday: number;
  projectEnabled: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** US-Dollar je Million Token */
  promptPrice: number;
  completionPrice: number;
  context: number;
  supportsJson: boolean;
}

export interface ModelList {
  models: ModelInfo[];
  suggested: string | null;
}

export interface AiBlockResult {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  state: "ok" | "issues" | "failed" | "skipped";
  message: string | null;
  diagnostics: Diagnostic[];
  cached: boolean;
}

export interface AiRun {
  summary: { calls: number; cached: number; tokens: number; stopped: string | null };
  blocks: Array<[string, string]>;
  skipped: string | null;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  connected: boolean;
}

export interface FbuildStatus {
  installed: boolean;
  version: string | null;
  enabled: boolean;
  boards: string[];
}

/* ---------- Sprachserver (clangd) ---------- */
export interface LspCompletion {
  label: string;
  kind: number;
  detail: string | null;
  insert: string;
  snippet: boolean;
  from: number | null;
  doc: string | null;
  sort: string | null;
}

export interface LspHover {
  text: string;
  line: number;
  from: number;
  to: number;
}

export interface LspLocation {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  external: boolean;
}

export interface LspSignature {
  label: string;
  params: Array<[number, number]>;
  active: number;
  doc: string | null;
}

export interface LspTokens {
  types: string[];
  modifiers: string[];
  tokens: Array<{ line: number; col: number; len: number; kind: number; mods: number }>;
}

export interface SearchHit {
  file: string;
  line: number;
  col: number;
  endCol: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/* ---------- Editor-Komfort: Symbole, Umbenennen, Formatieren ---------- */
export interface LspSymbol {
  name: string;
  detail: string | null;
  /** LSP-`SymbolKind` (12 Funktion, 6 Methode, 5 Klasse, 13 Variable, ...). */
  kind: number;
  /** Ab 1. */
  line: number;
  /** Ab 0, UTF-16. */
  col: number;
  endLine: number;
  endCol: number;
  /** Tiefe in der Gliederung, 0 für oberste Ebene. */
  depth: number;
  container: string | null;
}

/** Der Name, der sich umbenennen lässt, samt Stelle. */
export interface LspRenameTarget {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  name: string;
}

export interface LspFileEdits {
  file: string;
  edits: import("../diagnostics").TextEdit[];
}

/* ---------- Hardware und Build: Beispiele, Updates, Speicher ---------- */
export interface ExampleInfo {
  library: string;
  name: string;
  path: string;
  /** `core` für Bibliotheken, die der Core mitbringt. */
  source: "core" | "library";
}

export interface OutdatedItem {
  name: string;
  installed: string;
  latest: string;
}

export interface MemoryGroup {
  label: string;
  size: number;
  sections: Array<[string, number]>;
}

export interface SymbolSize {
  name: string;
  size: number;
  kind: "code" | "data" | "bss" | "rodata";
}

export interface MemoryDetail {
  groups: MemoryGroup[];
  symbols: SymbolSize[];
}

/** Eine aufgelöste Adresse aus einem Backtrace. */
export interface BacktraceFrame {
  addr: string;
  function: string;
  file: string;
  line: number;
}

/** Woher die Vorschau einer Webseite geladen wird: eine Adresse der App oder, im Browser, der Text selbst. */
export interface WebPreviewSource {
  src?: string;
  srcdoc?: string;
}

/** Ein Update des Programms selbst, gemeldet vom Update-Server. */
export interface AppUpdate {
  version: string;
  notes: string | null;
}
