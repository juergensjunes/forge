import type {
  AiBlockResult,
  AiFix,
  AiTaskResult,
  AiThread,
  AiThreadReply,
  AiRun,
  AiState,
  AnalysisOutput,
  BoardArg,
  BoardEntry,
  BoardOption,
  BuildEvent,
  BuildOutcome,
  ChipProbe,
  ExampleInfo,
  AppUpdate,
  MemoryDetail,
  OutdatedItem,
  FbuildStatus,
  CheckOutput,
  CreateProjectRequest,
  DeviceInfo,
  FileNode,
  FlashArgs,
  FlashResult,
  LibraryInfo,
  LibraryProgress,
  LibrarySearchHit,
  LspCompletion,
  LspHover,
  LspFileEdits,
  LspLocation,
  LspRenameTarget,
  LspSymbol,
  LspSignature,
  LspTokens,
  McpStatus,
  PackageNeeds,
  SearchOptions,
  SearchResult,
  ModelList,
  BacktraceFrame,
  MonitorLine,
  MonitorState,
  ProjectInfo,
  RecentProject,
  SecretStatus,
  WebPreviewSource,
  ToolchainProgress,
  ToolchainStatus,
} from "./types";
import type { Diagnostic } from "../diagnostics";

export type Unsubscribe = () => void;

/**
 * Alles, was die Oberfläche vom Rechner braucht. Die echte Umsetzung steckt in Rust (`tauri.ts`),
 * für Browser-Vorschau und Tests gibt es einen Speicher-Mock (`mock.ts`).
 */
export interface Backend {
  readonly native: boolean;

  pickFolder(): Promise<string | null>;
  /** Wählt eine .forgeproj-Datei zum Öffnen. */
  pickProjectFile(): Promise<string | null>;
  /** Fragt nach einem Ort für eine neue .forgeproj-Datei. */
  pickSavePath(defaultName: string): Promise<string | null>;
  defaultProjectsDir(): Promise<string>;

  openProject(path: string): Promise<ProjectInfo>;
  createProject(request: CreateProjectRequest): Promise<ProjectInfo>;
  createSketch(): Promise<ProjectInfo>;
  /** Benennt das geöffnete Projekt um (Ordner, Haupt-.ino, forge.toml und ggf. die .forgeproj-Datei). */
  renameProject(name: string): Promise<ProjectInfo>;
  /** Macht den geöffneten Sketch zum Projekt (schreibt forge.toml). */
  convertToProject(): Promise<ProjectInfo>;
  validateName(name: string): Promise<string | null>;
  projectTree(): Promise<FileNode[]>;

  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  createFile(path: string, isDir: boolean): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  trashFile(path: string): Promise<void>;

  closeProject(): Promise<void>;

  /* Projektdatei (.forgeproj) */
  packageNeeds(): Promise<PackageNeeds>;
  packageInstallNeeds(): Promise<void>;
  /** Speichert das Projekt unter neuem Namen oder Ort als .forgeproj. Forge arbeitet danach in der neuen Datei. */
  packageSaveAs(dest: string): Promise<ProjectInfo>;
  /** Entpackt das Projekt in einen Ordner `<parent>/<Name>`. */
  packageExportFolder(parent: string): Promise<string>;
  /** Schaltet Einträge der Menüleiste ein oder aus (Befehls-ID zu Zustand). */
  setMenuEnabled(states: Record<string, boolean>): Promise<void>;
  /** Die Projektdatei konnte nicht geschrieben werden. */
  onPackageError(handler: (message: string) => void): Promise<Unsubscribe>;

  /** Pfad, mit dem die App gestartet wurde (Kommandozeile, Finder). Gilt einmal. */
  takePendingOpen(): Promise<string | null>;
  /** Ein Pfad wird an die laufende App übergeben. */
  onOpenPath(handler: (path: string) => void): Promise<Unsubscribe>;

  /** Menüeinträge der macOS-Menüleiste, als Befehls-ID. */
  onMenu(handler: (id: string) => void): Promise<Unsubscribe>;
  /** Dateien im Projekt, die von außen geändert wurden. */
  onProjectChanged(handler: (paths: string[]) => void): Promise<Unsubscribe>;

  recentProjects(): Promise<RecentProject[]>;
  pushRecent(project: ProjectInfo): Promise<void>;
  removeRecent(path: string): Promise<void>;

  /* Toolchain und Boards */
  toolchainStatus(): Promise<ToolchainStatus>;
  toolchainSetup(): Promise<void>;
  toolchainSetupNrf(): Promise<void>;
  fbuildStatus(): Promise<FbuildStatus>;
  fbuildInstall(): Promise<void>;
  fbuildSetEnabled(enabled: boolean): Promise<void>;
  onToolchainProgress(handler: (p: ToolchainProgress) => void): Promise<Unsubscribe>;
  boards(): Promise<BoardEntry[]>;
  boardOptions(fqbn: string): Promise<BoardOption[]>;
  setBoard(fqbn: string, options: Record<string, string>): Promise<ProjectInfo>;

  /* Prüfung */
  syntax(file: string, text: string): Promise<Diagnostic[]>;
  check(board: BoardArg, overrides: Record<string, string>): Promise<CheckOutput>;
  analyze(board: BoardArg, overrides: Record<string, string>): Promise<AnalysisOutput>;

  /* Build und Flash */
  build(board: BoardArg, force: boolean): Promise<BuildOutcome>;
  cancelBuild(): Promise<void>;
  flash(args: FlashArgs): Promise<FlashResult>;
  onBuildEvent(handler: (e: BuildEvent) => void): Promise<Unsubscribe>;

  /* Geräte und Monitor */
  devices(): Promise<DeviceInfo[]>;
  onDevicesChanged(handler: (d: DeviceInfo[]) => void): Promise<Unsubscribe>;
  probeDevice(port: string): Promise<ChipProbe>;
  monitorStart(deviceId: string | null, port: string, baud: number): Promise<void>;
  monitorStop(): Promise<void>;
  monitorWrite(text: string, ending: "none" | "nl" | "cr" | "nlcr"): Promise<void>;
  onMonitorLines(handler: (lines: MonitorLine[]) => void): Promise<Unsubscribe>;
  onMonitorState(handler: (s: MonitorState) => void): Promise<Unsubscribe>;

  /* Bibliotheken */
  libraries(): Promise<LibraryInfo[]>;
  searchLibraries(query: string): Promise<LibrarySearchHit[]>;
  installLibrary(name: string, version?: string): Promise<void>;
  uninstallLibrary(name: string): Promise<void>;
  upgradeLibrary(name: string): Promise<void>;
  onLibraryProgress(handler: (p: LibraryProgress) => void): Promise<Unsubscribe>;

  /* Secrets (Schlüsselbund) */
  secrets(): Promise<SecretStatus[]>;
  setSecret(name: string, value: string, global: boolean): Promise<void>;
  removeSecret(name: string): Promise<void>;

  /* KI-Prüfung */
  aiState(): Promise<AiState>;
  aiConfigure(opts: { key?: string; model?: string; dailyTokens?: number }): Promise<void>;
  aiSetProjectEnabled(enabled: boolean): Promise<void>;
  aiModels(): Promise<ModelList>;
  /** `skip`: Dateien mit Strukturfehlern, die die KI nicht prüfen soll (Webdateien kennt nur die Oberfläche). */
  aiCheck(board: BoardArg, overrides: Record<string, string>, skip?: string[]): Promise<AiRun>;
  onAiBlock(handler: (r: AiBlockResult) => void): Promise<Unsubscribe>;
  /** Alle Gespräche über Hinweise der KI im Projekt. */
  aiThreads(): Promise<AiThread[]>;
  /** Der Nutzer antwortet auf einen Hinweis, die KI antwortet darauf. Stimmt sie zu, ist das Gespräch danach geschlossen. */
  aiThreadReply(board: BoardArg, overrides: Record<string, string>, threadId: string, text: string): Promise<AiThreadReply>;
  aiThreadClose(threadId: string): Promise<AiThread>;
  aiThreadReopen(threadId: string): Promise<AiThread>;
  /** Die KI behebt einen Hinweis. Die Änderung kommt zurück und wird im Editor angewendet. */
  /** Die KI setzt eine Aufgabe um. Sie liefert Änderungen, angewendet werden sie im Editor. */
  aiTask(board: BoardArg, overrides: Record<string, string>, task: string, active: string | null, problems: string): Promise<AiTaskResult>;
  aiFix(board: BoardArg, overrides: Record<string, string>, file: string, line: number, message: string): Promise<AiFix>;

  /* Claude Code (MCP) */
  mcpStatus(): Promise<McpStatus>;
  mcpSetEnabled(enabled: boolean): Promise<void>;
  mcpConnect(): Promise<void>;
  mcpOpenInClaude(): Promise<void>;

  /* Sprachserver */
  lspSync(board: BoardArg, overrides: Record<string, string>): Promise<boolean>;
  lspComplete(file: string, line: number, col: number): Promise<LspCompletion[]>;
  lspHover(file: string, line: number, col: number): Promise<LspHover | null>;
  lspDefinition(file: string, line: number, col: number): Promise<LspLocation[]>;
  lspSignature(file: string, line: number, col: number): Promise<LspSignature | null>;
  lspTokens(file: string): Promise<LspTokens | null>;
  /** Datei aus Core, Bibliothek oder Projekt zum Nachschlagen. */
  readExternal(path: string): Promise<string>;

  /* Suche */
  search(query: string, options: SearchOptions, overrides: Record<string, string>): Promise<SearchResult>;

  /* Editor-Komfort */
  /** Ob clang-format gefunden wurde. */
  formatAvailable(): Promise<boolean>;
  /** Formatiert den Text einer Datei mit clang-format und gibt das Ergebnis zurück. */
  formatDocument(path: string, text: string): Promise<string>;
  /** Gliederung einer Datei (Funktionen, Klassen, Variablen), flach mit Tiefe. `null` ohne Sprachserver. */
  lspSymbols(file: string): Promise<LspSymbol[] | null>;
  /** Alle Verwendungen des Namens an der Stelle, nur im Projekt. */
  lspReferences(file: string, line: number, col: number): Promise<LspLocation[]>;
  /** Welcher Name sich an der Stelle umbenennen lässt. `null`, wenn nichts oder nichts im Projekt. */
  lspPrepareRename(file: string, line: number, col: number): Promise<LspRenameTarget | null>;
  /** Änderungen für das Umbenennen, nur an Projektdateien. */
  lspRename(file: string, line: number, col: number, newName: string): Promise<LspFileEdits[]>;
  /* Hardware und Build */
  /** Beispiele von Core und Bibliotheken, mit Board nur die passenden. */
  examples(fqbn?: string): Promise<ExampleInfo[]>;
  /** Öffnet eine Kopie des Beispiels als neuen Sketch. */
  openExample(path: string): Promise<ProjectInfo>;
  /** Aktualisiert den ESP32-Core. Fortschritt über `onToolchainProgress`. */
  coreUpgrade(): Promise<void>;
  /** Lädt die Paketliste neu, wenn sie älter als 24 Stunden ist. Gibt zurück, ob sie neu geladen wurde. */
  refreshIndexIfStale(): Promise<boolean>;
  outdatedLibraries(): Promise<OutdatedItem[]>;
  pickLibraryZip(): Promise<string | null>;
  installLibraryZip(path: string): Promise<void>;
  /** Abschnitte und größte Symbole des letzten Builds. */
  memoryDetail(): Promise<MemoryDetail>;
  otaPasswordSet(deviceId: string): Promise<boolean>;
  setOtaPassword(deviceId: string, password: string | null): Promise<void>;
  /** Fragt nach einem Ort und schreibt den Text dorthin. Liefert den Pfad, oder null bei Abbruch. */
  saveTextAs(defaultName: string, text: string): Promise<string | null>;
  /** Startet das Board über DTR/RTS neu. */
  monitorReset(): Promise<void>;
  /** Ändert die Baudrate bei offenem Monitor, ohne den Port zu schließen. */
  monitorSetBaud(baud: number): Promise<void>;
  /** Löst Adressen einer Monitor-Zeile mit addr2line gegen den letzten Build auf. */
  decodeBacktrace(text: string): Promise<BacktraceFrame[]>;
  /** Fragt den Update-Server. Wirft, wenn Updates nicht eingerichtet sind oder der Server nicht antwortet. */
  appUpdateCheck(): Promise<AppUpdate | null>;
  /** Lädt und installiert das Update. Der Neustart folgt mit `appRestart`. */
  appUpdateInstall(): Promise<void>;
  appRestart(): Promise<void>;

  /* Webseiten */
  /** Legt die Seite zur Anzeige bereit. Das Vorschaufenster lädt sie von der zurückgegebenen Adresse. */
  webPreview(html: string): Promise<WebPreviewSource>;
}



