import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Backend } from "./backend";
import type { Diagnostic } from "../diagnostics";
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
  PackageNeeds,
  McpStatus,
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

/** Rust-Befehle liefern Fehler als Text. Daraus wird ein normaler Error. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

/**
 * Leere Felder schreibt der Kern gar nicht erst in die Antwort (Sketches haben keine `forge.toml`).
 * Die Oberfläche rechnet mit vollständigen Daten, deshalb füllen wir sie hier auf.
 */
export function complete(p: ProjectInfo): ProjectInfo {
  const c = p.config ?? ({} as ProjectInfo["config"]);
  return {
    ...p,
    config: {
      ...c,
      board: { ...c.board, options: c.board?.options ?? {} },
      libraries: c.libraries ?? {},
      secrets: c.secrets ?? { names: [] },
      ai: c.ai ?? { enabled: true },
    },
  };
}

export function createTauriBackend(): Backend {
  return {
    native: true,

    async pickFolder() {
      const res = await openDialog({ directory: true, multiple: false, title: "Projekt oder Sketch öffnen" });
      return typeof res === "string" ? res : null;
    },
    async pickProjectFile() {
      const res = await openDialog({
        multiple: false,
        title: "Forge-Projekt öffnen",
        filters: [{ name: "Forge-Projekt", extensions: ["forgeproj"] }],
      });
      return typeof res === "string" ? res : null;
    },
    async pickSavePath(defaultName) {
      return (
        (await saveDialog({
          title: "Als Projektdatei sichern",
          defaultPath: defaultName,
          filters: [{ name: "Forge-Projekt", extensions: ["forgeproj"] }],
        })) ?? null
      );
    },
    defaultProjectsDir: () => call("default_projects_dir"),

    openProject: (path) => call<ProjectInfo>("project_open", { path }).then(complete),
    createProject: (request: CreateProjectRequest) => call<ProjectInfo>("project_create", { request }).then(complete),
    createSketch: () => call<ProjectInfo>("sketch_create").then(complete),
    renameProject: (name) => call<ProjectInfo>("project_rename", { name }).then(complete),
    convertToProject: () => call<ProjectInfo>("project_convert").then(complete),
    validateName: (name) => call<string | null>("project_validate_name", { name }),
    projectTree: () => call<FileNode[]>("project_tree"),

    readFile: (path) => call<string>("file_read", { path }),
    writeFile: (path, text) => call<void>("file_write", { path, text }),
    createFile: (path, isDir) => call<void>("file_create", { path, isDir }),
    renameFile: (from, to) => call<void>("file_rename", { from, to }),
    trashFile: (path) => call<void>("file_trash", { path }),

    closeProject: () => call<void>("project_close"),

    setMenuEnabled: (states) => call<void>("menu_set_enabled", { states }),
    packageNeeds: () => call<PackageNeeds>("package_needs"),
    packageInstallNeeds: () => call<void>("package_install_needs"),
    packageSaveAs: (dest) => call<ProjectInfo>("package_save_as", { dest }).then(complete),
    packageExportFolder: (parent) => call<string>("package_export_folder", { parent }),
    onPackageError: (handler) => listen<string>("package:error", (e) => handler(e.payload)),
    takePendingOpen: () => call<string | null>("take_pending_open"),
    onOpenPath: (handler) => listen<string>("open-path", (e) => handler(e.payload)),

    onMenu: (handler) => listen<string>("menu", (e) => handler(e.payload)),
    onProjectChanged: (handler) => listen<{ paths: string[] }>("project:changed", (e) => handler(e.payload.paths)),

    toolchainStatus: () => call<ToolchainStatus>("toolchain_status"),
    toolchainSetup: () => call<void>("toolchain_setup"),
    toolchainSetupNrf: () => call<void>("toolchain_setup_nrf"),
    onToolchainProgress: (h) => listen<ToolchainProgress>("toolchain:progress", (e) => h(e.payload)),
    boards: () => call<BoardEntry[]>("boards_list"),
    boardOptions: (fqbn) => call<BoardOption[]>("board_options", { fqbn }),
    setBoard: (fqbn, options) => call<ProjectInfo>("project_set_board", { fqbn, options }).then(complete),

    syntax: (file, text) => call<Diagnostic[]>("syntax_run", { file, text }),
    check: (board: BoardArg, overrides) => call<CheckOutput>("check_run", { board, overrides }),
    analyze: (board: BoardArg, overrides) => call<AnalysisOutput>("analysis_run", { board, overrides }),

    build: (board: BoardArg, force) => call<BuildOutcome>("build_run", { board, force }),
    cancelBuild: () => call<void>("build_cancel"),
    flash: (args: FlashArgs) => call<FlashResult>("flash_run", { args }),
    onBuildEvent: (h) => listen<BuildEvent>("build:event", (e) => h(e.payload)),

    devices: () => call<DeviceInfo[]>("devices_list"),
    onDevicesChanged: (h) => listen<DeviceInfo[]>("devices:changed", (e) => h(e.payload)),
    probeDevice: (port) => call<ChipProbe>("device_probe", { port }),
    monitorStart: (deviceId, port, baud) => call<void>("monitor_start", { deviceId, port, baud }),
    monitorStop: () => call<void>("monitor_stop"),
    monitorWrite: (text, ending) => call<void>("monitor_write", { text, ending }),
    onMonitorLines: (h) => listen<MonitorLine[]>("monitor:lines", (e) => h(e.payload)),
    onMonitorState: (h) => listen<MonitorState>("monitor:state", (e) => h(e.payload)),

    libraries: () => call<LibraryInfo[]>("libraries_installed"),
    searchLibraries: (query) => call<LibrarySearchHit[]>("libraries_search", { query }),
    installLibrary: (name, version) => call<void>("library_install", { name, version: version ?? null }),
    uninstallLibrary: (name) => call<void>("library_uninstall", { name }),
    upgradeLibrary: (name) => call<void>("library_upgrade", { name }),
    onLibraryProgress: (h) => listen<LibraryProgress>("library:progress", (e) => h(e.payload)),

    secrets: () => call<SecretStatus[]>("secrets_list"),
    setSecret: (name, value, global) => call<void>("secret_set", { name, value, global }),
    removeSecret: (name) => call<void>("secret_remove", { name }),

    search: (query, o, overrides) => call<SearchResult>("search_run", { query, caseSensitive: o.caseSensitive, wholeWord: o.wholeWord, regex: o.regex, overrides }),
    lspSync: (board, overrides) => call<boolean>("lsp_sync", { board, overrides }),
    lspComplete: (file, line, col) => call<LspCompletion[]>("lsp_complete", { file, line, col }),
    lspHover: (file, line, col) => call<LspHover | null>("lsp_hover", { file, line, col }),
    lspDefinition: (file, line, col) => call<LspLocation[]>("lsp_definition", { file, line, col }),
    lspSignature: (file, line, col) => call<LspSignature | null>("lsp_signature", { file, line, col }),
    lspTokens: (file) => call<LspTokens | null>("lsp_tokens", { file }),
    readExternal: (path) => call<string>("file_read_external", { path }),
    fbuildStatus: () => call<FbuildStatus>("fbuild_status"),
    fbuildInstall: () => call<void>("fbuild_install"),
    fbuildSetEnabled: (enabled) => call<void>("fbuild_set_enabled", { enabled }),
    mcpStatus: () => call<McpStatus>("mcp_status"),
    mcpSetEnabled: (enabled) => call<void>("mcp_set_enabled", { enabled }),
    mcpConnect: () => call<void>("mcp_connect"),
    mcpOpenInClaude: () => call<void>("mcp_open_in_claude"),
    aiState: () => call<AiState>("ai_state"),
    aiConfigure: (o) => call<void>("ai_configure", { keyValue: o.key ?? null, model: o.model ?? null, dailyTokens: o.dailyTokens ?? null }),
    aiSetProjectEnabled: (enabled) => call<void>("ai_set_project_enabled", { enabled }),
    aiModels: () => call<ModelList>("ai_models"),
    aiCheck: (board: BoardArg, overrides, skip) => call<AiRun>("ai_check", { board, overrides, skip: skip ?? [] }),
    aiThreads: () => call<AiThread[]>("ai_threads"),
    aiThreadReply: (board, overrides, threadId, text) => call<AiThreadReply>("ai_thread_reply", { board, overrides, threadId, text }),
    aiThreadClose: (threadId) => call<AiThread>("ai_thread_close", { threadId }),
    aiThreadReopen: (threadId) => call<AiThread>("ai_thread_reopen", { threadId }),
    aiTask: (board, overrides, task, active, problems) => call<AiTaskResult>("ai_task", { board, overrides, task, active, problems }),
    aiFix: (board, overrides, file, line, message) => call<AiFix>("ai_fix", { board, overrides, file, line, message }),
    onAiBlock: (h) => listen<AiBlockResult>("ai:block", (e) => h(e.payload)),

    recentProjects: () => call<RecentProject[]>("recent_list"),
    // Projekte aus einer .forgeproj-Datei merken sich die Datei, nicht ihren Arbeitsordner.
    pushRecent: (p) => call<void>("recent_push", { path: p.package ?? p.path, name: p.name, kind: p.kind }),
    removeRecent: (path) => call<void>("recent_remove", { path }),

    formatAvailable: () => call<boolean>("format_available"),
    formatDocument: (path, text) => call<string>("format_document", { path, text }),
    lspSymbols: (file) => call<LspSymbol[] | null>("lsp_symbols", { file }),
    lspReferences: (file, line, col) => call<LspLocation[]>("lsp_references", { file, line, col }),
    lspPrepareRename: (file, line, col) => call<LspRenameTarget | null>("lsp_prepare_rename", { file, line, col }),
    lspRename: (file, line, col, newName) => call<LspFileEdits[]>("lsp_rename", { file, line, col, newName }),
    examples: (fqbn) => call<ExampleInfo[]>("examples_list", { fqbn: fqbn ?? null }),
    openExample: (path) => call<ProjectInfo>("example_open", { path }).then(complete),
    coreUpgrade: () => call<void>("core_upgrade"),
    refreshIndexIfStale: () => call<boolean>("toolchain_refresh_index"),
    outdatedLibraries: () => call<OutdatedItem[]>("libraries_outdated"),
    async pickLibraryZip() {
      const res = await openDialog({ multiple: false, title: "Bibliothek als ZIP installieren", filters: [{ name: "ZIP-Archiv", extensions: ["zip"] }] });
      return typeof res === "string" ? res : null;
    },
    installLibraryZip: (path) => call<void>("library_install_zip", { path }),
    memoryDetail: () => call<MemoryDetail>("build_memory_detail"),
    otaPasswordSet: (deviceId) => call<boolean>("ota_password_status", { deviceId }),
    setOtaPassword: (deviceId, password) => call<void>("ota_password_set", { deviceId, password }),
    monitorReset: () => call<void>("monitor_reset"),
    monitorSetBaud: (baud) => call<void>("monitor_set_baud", { baud }),
    decodeBacktrace: (text) => call<BacktraceFrame[]>("backtrace_decode", { text }),
    async saveTextAs(defaultName, text) {
      const path = await saveDialog({ title: "Speichern unter", defaultPath: defaultName });
      if (!path) return null;
      await call<void>("export_write", { path, text });
      return path;
    },
    appUpdateCheck: () => call<AppUpdate | null>("update_check"),
    appUpdateInstall: () => call<void>("update_install"),
    appRestart: () => call<void>("update_restart"),
    webPreview: async (html) => ({ src: await call<string>("web_preview_set", { html }) }) satisfies WebPreviewSource,
  };
}
