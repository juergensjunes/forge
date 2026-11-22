use super::secrets::{ensure_library, project_secret_names, store};
use super::toolchain::fbuild_path;
use crate::state::{AppState, Jobs, MonitorSpec};
use crate::store;
use forge_core::Diagnostic;
use forge_devices::{Monitor, MonitorConfig};
use forge_project::secrets_id;
use forge_secrets::{keychain, nvs};
use forge_toolchain::build::{
    build, build_dir, BuildEvent, BuildOutcome, BuildRequest, BuildStatus,
};
use forge_toolchain::check::CheckRequest;
use forge_toolchain::flash::{flash, FlashOutcome, FlashRequest};
use forge_toolchain::models::fqbn_with_options;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Deserialize)]
pub struct BoardArg {
    pub fqbn: String,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

impl BoardArg {
    pub fn full(&self) -> String {
        fqbn_with_options(&self.fqbn, &self.options)
    }
}

/// Schnelle Strukturprüfung für den Editor. Läuft in Mikrosekunden.
#[tauri::command]
pub fn syntax_run(file: String, text: String) -> Vec<Diagnostic> {
    forge_analysis::syntax_diagnostics(&file, &text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOutput {
    pub diagnostics: Vec<Diagnostic>,
    pub facts: Vec<forge_analysis::FunctionFacts>,
}

/// Regeln ohne Compiler: tote Funktionen, Interrupt-Fallen, Pinregeln, unvollständige switch-Fälle.
#[tauri::command]
pub async fn analysis_run(
    state: State<'_, AppState>,
    board: BoardArg,
    overrides: HashMap<String, String>,
) -> Result<AnalysisOutput, String> {
    let root = state.root()?;
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        for path in forge_toolchain::hash::source_files(&root) {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !matches!(ext.as_str(), "ino" | "cpp" | "c" | "cc" | "h" | "hpp") {
                continue;
            }
            let key = path.to_string_lossy().to_string();
            let text = overrides
                .get(&key)
                .cloned()
                .or_else(|| std::fs::read_to_string(&path).ok());
            if let Some(text) = text {
                files.push(forge_analysis::SourceFile { path: key, text });
            }
        }
        let chip = forge_analysis::Chip::from_fqbn(&board.fqbn);
        let r = forge_analysis::analyze(&forge_analysis::AnalysisInput {
            files: &files,
            chip,
        });
        let mut diagnostics = r.diagnostics;
        for f in &files {
            diagnostics.extend(forge_secrets::scan::diagnostics(&f.path, &f.text));
        }
        AnalysisOutput {
            diagnostics,
            facts: r.facts,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutput {
    pub ran: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub note: Option<String>,
    pub duration_ms: u64,
}

/// Prüft den Sketch mit dem Compiler (auch ungespeicherten Text). Ein neuer Aufruf bricht den laufenden ab.
#[tauri::command]
pub async fn check_run(
    state: State<'_, AppState>,
    board: BoardArg,
    overrides: HashMap<String, String>,
) -> Result<CheckOutput, String> {
    let root = state.root()?;
    ensure_library(&state, &overrides.values().collect::<Vec<_>>()).await?;
    let cancel = Jobs::begin(&state.jobs.check);
    let meta = state.toolchain.meta().await?;
    let checker = state.toolchain.checker()?;
    let req = CheckRequest {
        root,
        fqbn: board.full(),
        overrides: overrides
            .into_iter()
            .map(|(k, v)| (PathBuf::from(k), v))
            .collect(),
        libraries_signature: forge_toolchain::build::libs_signature(&meta.library_pairs()),
    };
    match checker.check(&req, &cancel).await {
        Ok(r) => Ok(CheckOutput {
            ran: r.ran,
            diagnostics: r.diagnostics,
            note: r.note,
            duration_ms: r.duration_ms,
        }),
        Err(forge_toolchain::Error::Cancelled) => Err("abgebrochen".into()),
        Err(e) => Err(e.to_string()),
    }
}

fn emit_build(app: &AppHandle) -> impl FnMut(BuildEvent) + Send + '_ {
    move |e| {
        let _ = app.emit("build:event", e);
    }
}

pub(crate) async fn run_build(
    app: &AppHandle,
    state: &AppState,
    board: &BoardArg,
    force: bool,
) -> Result<BuildOutcome, String> {
    let root = state.root()?;
    ensure_library(state, &[]).await?;
    let cancel = Jobs::begin(&state.jobs.build);
    let meta = state.toolchain.meta().await?;
    let fqbn = board.full();
    let fbuild = if store::build_settings(app).fbuild_enabled {
        fbuild_path(app)
    } else {
        None
    };
    let library_dirs: Vec<PathBuf> = meta
        .libraries
        .iter()
        .filter(|l| l.location == "user")
        .filter_map(|l| l.install_dir.clone())
        .collect();
    let req = BuildRequest {
        root,
        fqbn: fqbn.clone(),
        libraries: meta.library_pairs(),
        core_version: meta.core_version(&board.fqbn),
        cli_version: meta.cli_version.clone(),
        force,
        cache_base: state.toolchain.cache_base(),
        fbuild,
        library_dirs,
    };
    let cli = state.toolchain.cli()?;
    let checker = state.toolchain.checker()?;
    let outcome = build(&cli, &checker, &req, &cancel, emit_build(app))
        .await
        .map_err(|e| e.to_string())?;
    if outcome.status != BuildStatus::Failed {
        if let Ok(mut g) = state.last_build.lock() {
            *g = Some(outcome.clone());
        }
    }
    Ok(outcome)
}

/// Kompiliert. Unveränderte Sketches werden übersprungen.
#[tauri::command]
pub async fn build_run(
    app: AppHandle,
    state: State<'_, AppState>,
    board: BoardArg,
    force: bool,
) -> Result<BuildOutcome, String> {
    run_build(&app, &state, &board, force).await
}

#[tauri::command]
pub fn build_cancel(state: State<AppState>) {
    Jobs::cancel(&state.jobs.build);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashArgs {
    pub board: BoardArg,
    pub port: String,
    pub device_id: Option<String>,
    pub erase_all: bool,
    /// Auch flashen, wenn das Board schon diesen Stand hat.
    pub force: bool,
    /// Ohne Angabe wird seriell über `port` geflasht.
    #[serde(default)]
    pub target: Option<FlashTarget>,
}

/// Wohin die Firmware geht: über ein Kabel (esptool) oder per WLAN (OTA).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlashTarget {
    Serial { port: String },
    Network { host: String, port: u16 },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FlashResult {
    Flashed {
        build: BuildOutcome,
        flash: FlashOutcome,
    },
    AlreadyCurrent {
        build: BuildOutcome,
    },
    BuildFailed {
        build: BuildOutcome,
    },
    /// Dem Code fehlen Secrets. Sie lassen sich im Schlüsselbund eintragen.
    SecretsMissing {
        names: Vec<String>,
    },
}

/// Die NVS-Partition mit den Secrets, bereit zum Schreiben.
struct NvsPlan {
    offset: u64,
    path: PathBuf,
    hash: String,
    names: Vec<String>,
}

enum SecretsError {
    Missing(Vec<String>),
    Other(String),
}

fn prepare_secrets(
    root: &std::path::Path,
    outcome: &BuildOutcome,
) -> Result<Option<NvsPlan>, SecretsError> {
    let (declared, used) = project_secret_names(root);
    let names: Vec<String> = declared.union(&used).cloned().collect();
    if names.is_empty() {
        return Ok(None);
    }
    let id = secrets_id(root);
    let s = store();
    let mut entries = Vec::new();
    let mut missing = Vec::new();
    for n in &names {
        match keychain::resolve(&s, &id, n).map_err(|e| SecretsError::Other(e.to_string()))? {
            Some((v, _)) => entries.push((n.clone(), v)),
            None => missing.push(n.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(SecretsError::Missing(missing));
    }
    let part = outcome
        .partitions
        .iter()
        .find(|p| p.name == "nvs" || p.subtype == "nvs")
        .ok_or_else(|| {
            SecretsError::Other(
                "Das Partitionsschema hat keine NVS-Partition für die Secrets.".into(),
            )
        })?;
    let image = nvs::build("forge", &entries, part.size as usize)
        .map_err(|e| SecretsError::Other(e.to_string()))?;
    let path = outcome.build_dir.join("forge-nvs.bin");
    std::fs::write(&path, &image).map_err(|e| SecretsError::Other(e.to_string()))?;
    let mut h = Sha256::new();
    for (k, v) in &entries {
        h.update(k.as_bytes());
        h.update([0]);
        h.update(v.as_bytes());
        h.update([0]);
    }
    h.update(part.offset.to_le_bytes());
    Ok(Some(NvsPlan {
        offset: part.offset,
        path,
        hash: format!("{:x}", h.finalize()),
        names,
    }))
}

/// Kompiliert bei Bedarf und flasht. Der Monitor gibt den Port dafür frei und kommt danach zurück.
#[tauri::command]
pub async fn flash_run(
    app: AppHandle,
    state: State<'_, AppState>,
    args: FlashArgs,
) -> Result<FlashResult, String> {
    let outcome = run_build(&app, &state, &args.board, false).await?;
    if outcome.status == BuildStatus::Failed {
        return Ok(FlashResult::BuildFailed { build: outcome });
    }

    let root = state.root()?;
    if let Some(FlashTarget::Network { host, port }) = args.target.clone() {
        return flash_network(&app, &state, &args, outcome, &host, port).await;
    }
    let args = FlashArgs {
        port: match &args.target {
            Some(FlashTarget::Serial { port }) => port.clone(),
            _ => args.port.clone(),
        },
        ..args
    };

    // Nicht-ESP-Boards (XIAO nRF52840): Upload-Rezept des Cores, kein esptool, keine Secrets.
    if !crate::commands::toolchain::is_esp32_fqbn(&args.board.full()) {
        return flash_with_core(&app, &state, &args, outcome).await;
    }

    // Secrets aus dem Schlüsselbund. Fehlt etwas, wird nicht geflasht.
    let plan = match prepare_secrets(&root, &outcome) {
        Ok(p) => p,
        Err(SecretsError::Missing(names)) => return Ok(FlashResult::SecretsMissing { names }),
        Err(SecretsError::Other(e)) => return Err(e),
    };

    // Das Board hat diesen Stand schon? Dann gibt es nichts zu tun. Nur bei sicherer Kennung.
    let key = args.device_id.clone().filter(|id| !id.starts_with("port:"));
    let nvs_key = key.as_ref().map(|k| format!("{k}#nvs"));
    let firmware_current = key.as_ref().is_some_and(|k| {
        !args.force
            && !args.erase_all
            && store::flashed_hash(&app, k).as_deref() == Some(outcome.hash.as_str())
    });
    let nvs_needed = plan.as_ref().is_some_and(|p| {
        args.force
            || args.erase_all
            || nvs_key
                .as_ref()
                .map(|k| store::flashed_hash(&app, k))
                .unwrap_or(None)
                .as_deref()
                != Some(p.hash.as_str())
    });
    if firmware_current && !nvs_needed {
        return Ok(FlashResult::AlreadyCurrent { build: outcome });
    }

    let cli = state.toolchain.cli()?;
    let esptool = state.toolchain.esptool().await?;
    let props = cli
        .board_properties(&args.board.full())
        .await
        .map_err(|e| e.to_string())?;
    let chip = props
        .get("build.mcu")
        .cloned()
        .ok_or("Für dieses Board ist kein Chip bekannt.")?;
    let baud: u32 = props
        .get("upload.speed")
        .and_then(|s| s.parse().ok())
        .unwrap_or(460_800);

    // Port freigeben.
    let resume = stop_monitor(&state);

    let cancel = Jobs::begin(&state.jobs.build);
    let result = flash(
        &FlashRequest {
            esptool,
            chip,
            port: args.port.clone(),
            baud,
            build_dir: build_dir(&state.toolchain.cache_base(), &root, &args.board.full()),
            extra: plan
                .iter()
                .filter(|_| nvs_needed || !firmware_current)
                .map(|p| (p.offset, p.path.clone()))
                .collect(),
            erase_all: args.erase_all,
            skip_firmware: firmware_current,
        },
        &cancel,
        emit_build(&app),
    )
    .await;

    if let Some(spec) = resume {
        // Das Board startet neu und meldet sich oft unter neuem Namen. Die Geräte-ID findet es wieder.
        start_monitor(&app, &state, spec);
    }

    let flash = result.map_err(|e| e.to_string())?;
    if let Some(key) = &key {
        if !firmware_current {
            store::set_flashed_hash(&app, key, &outcome.hash);
        }
        if let (Some(k), Some(p)) = (&nvs_key, &plan) {
            store::set_flashed_hash(&app, k, &p.hash);
            let _ = app.emit(
                "build:event",
                BuildEvent::Output {
                    line: format!("Secrets geschrieben: {}", p.names.join(", ")),
                    level: "info".into(),
                },
            );
        }
    }
    if let (Some(mac), Some(id)) = (&flash.mac, &args.device_id) {
        let _ = app.emit(
            "device:identified",
            serde_json::json!({ "id": id, "mac": mac, "chip": flash.chip }),
        );
    }
    Ok(FlashResult::Flashed {
        build: outcome,
        flash,
    })
}

/// Flasht über `arduino-cli upload`. Das Rezept des Cores setzt den Bootloader selbst (1200-Baud-Touch).
async fn flash_with_core(
    app: &AppHandle,
    state: &AppState,
    args: &FlashArgs,
    outcome: BuildOutcome,
) -> Result<FlashResult, String> {
    let root = state.root()?;
    let cli = state.toolchain.cli()?;
    let fqbn = args.board.full();
    let dir = build_dir(&state.toolchain.cache_base(), &root, &fqbn);
    let started = std::time::Instant::now();
    let bytes = std::fs::read_dir(&dir)
        .ok()
        .and_then(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "hex"))
        })
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let resume = stop_monitor(state);
    let cancel = Jobs::begin(&state.jobs.build);
    let emit = emit_build(app);
    let mut emit = emit;
    let result = cli
        .upload(&fqbn, &args.port, &dir, &root, &cancel, |_, l| {
            emit(BuildEvent::Output {
                line: l.to_string(),
                level: "info".into(),
            })
        })
        .await;
    if let Some(spec) = resume {
        // Das Board startet neu und meldet sich oft unter neuem Namen.
        start_monitor(app, state, spec);
    }
    result.map_err(|e| e.to_string())?;
    Ok(FlashResult::Flashed {
        build: outcome,
        flash: FlashOutcome {
            duration_ms: started.elapsed().as_millis() as u64,
            bytes,
            chip: Some("nRF52840".into()),
            mac: None,
        },
    })
}

/// Die App-Partition, die per OTA geschrieben wird: die Region bei 0x10000, sonst die letzte.
fn ota_firmware(build_dir: &std::path::Path) -> Option<PathBuf> {
    let regions = forge_toolchain::flash::region_files(build_dir);
    regions
        .iter()
        .find(|(off, _)| off.eq_ignore_ascii_case("0x10000"))
        .or(regions.last())
        .map(|(_, file)| build_dir.join(file))
}

/// Update per WLAN: espota-Protokoll in Rust. Nur die App-Partition, die Secrets (NVS) bleiben unberührt.
async fn flash_network(
    app: &AppHandle,
    state: &AppState,
    args: &FlashArgs,
    outcome: BuildOutcome,
    host: &str,
    port: u16,
) -> Result<FlashResult, String> {
    let ip: std::net::IpAddr = host
        .parse()
        .map_err(|_| format!("{host} ist keine gültige Adresse."))?;
    let key = args.device_id.clone();
    if !args.force
        && key
            .as_ref()
            .is_some_and(|k| store::flashed_hash(app, k).as_deref() == Some(outcome.hash.as_str()))
    {
        return Ok(FlashResult::AlreadyCurrent { build: outcome });
    }
    let firmware = ota_firmware(&outcome.build_dir)
        .filter(|p| p.is_file())
        .ok_or("Der Build enthält keine Firmware. Kompiliere neu.")?;
    let password = key.as_deref().and_then(super::devices::ota_password);
    let say = |line: &str| {
        let _ = app.emit(
            "build:event",
            BuildEvent::Output {
                line: line.into(),
                level: "info".into(),
            },
        );
    };
    let root = state.root()?;
    let (declared, used) = project_secret_names(&root);
    if !declared.is_empty() || !used.is_empty() {
        say("Per WLAN wird nur das Programm übertragen. Die Secrets auf dem Board bleiben, wie sie sind.");
    }
    say(&format!("Übertrage an {host}:{port}"));

    let phase = |app: &AppHandle, stage: usize, progress: f32, detail: &str| {
        let _ = app.emit(
            "build:event",
            BuildEvent::Phase {
                stage,
                progress,
                detail: detail.into(),
            },
        );
    };
    phase(app, 2, 0.3, "Verbinde");

    let cancel = Jobs::begin(&state.jobs.build);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let (stop, cancel) = (stop.clone(), cancel.clone());
        tokio::spawn(async move {
            cancel.cancelled().await;
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        })
    };
    let started = std::time::Instant::now();
    let handle = app.clone();
    let stop_flag = stop.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut connected = false;
        forge_devices::ota::upload(
            &forge_devices::ota::OtaRequest {
                ip,
                port,
                firmware,
                password,
                timeout: std::time::Duration::from_secs(10),
            },
            &stop_flag,
            |p| {
                let say = |stage: usize, progress: f32, detail: &str| {
                    let _ = handle.emit(
                        "build:event",
                        BuildEvent::Phase {
                            stage,
                            progress,
                            detail: detail.into(),
                        },
                    );
                };
                if !connected {
                    connected = true;
                    say(2, 1.0, "Verbunden");
                    say(3, 1.0, "Kein Löschen nötig");
                }
                say(4, p, "Schreibe");
            },
        )
    })
    .await
    .map_err(|e| e.to_string());
    watcher.abort();
    let bytes = match result? {
        Ok(b) => b,
        Err(forge_devices::ota::OtaError::Cancelled) => {
            return Err(forge_toolchain::Error::Cancelled.to_string())
        }
        Err(e) => return Err(e.to_string()),
    };
    phase(app, 5, 1.0, "Neustart");
    if let Some(k) = &key {
        store::set_flashed_hash(app, k, &outcome.hash);
    }
    Ok(FlashResult::Flashed {
        build: outcome,
        flash: FlashOutcome {
            duration_ms: started.elapsed().as_millis() as u64,
            bytes,
            chip: None,
            mac: None,
        },
    })
}

/// Abschnitte und größte Symbole des letzten Builds.
#[tauri::command]
pub async fn build_memory_detail(
    state: State<'_, AppState>,
) -> Result<forge_toolchain::memory::MemoryDetail, String> {
    let dir = state
        .last_build
        .lock()
        .map_err(|_| "Zustand gesperrt".to_string())?
        .as_ref()
        .map(|b| b.build_dir.clone())
        .ok_or("Es gibt noch keinen Build. Kompiliere zuerst.")?;
    forge_toolchain::memory::memory_detail(&dir)
        .await
        .map_err(|e| e.to_string())
}

pub fn stop_monitor(state: &AppState) -> Option<MonitorSpec> {
    let taken = state.devices.monitor.lock().ok().and_then(|mut g| g.take());
    taken.map(|(m, spec)| {
        m.stop();
        spec
    })
}

pub fn start_monitor(app: &AppHandle, state: &AppState, spec: MonitorSpec) {
    let handle = app.clone();
    let monitor = Monitor::start(
        MonitorConfig {
            port: spec.port.clone(),
            device_id: spec.device_id.clone(),
            baud: spec.baud,
            reset_on_open: false,
        },
        move |event| match event {
            forge_devices::MonitorEvent::Lines(lines) => {
                remember_lines(&handle, &lines);
                let _ = handle.emit("monitor:lines", lines);
            }
            forge_devices::MonitorEvent::State(s) => {
                let _ = handle.emit("monitor:state", s);
            }
        },
    );
    if let Ok(mut g) = state.devices.monitor.lock() {
        if let Some((old, _)) = g.replace((monitor, spec)) {
            old.stop();
        }
    }
}

const LOG_LINES: usize = 2000;

/// Hält die letzten Zeilen fest, damit MCP-Clients sie lesen können.
fn remember_lines(app: &AppHandle, lines: &[forge_devices::Line]) {
    let state = tauri::Manager::state::<AppState>(app);
    let Ok(mut log) = state.devices.log.lock() else {
        return;
    };
    for l in lines {
        let text = match l.kind {
            forge_devices::LineKind::Tx => format!("> {}", l.text),
            _ => l.text.clone(),
        };
        log.push_back(text);
    }
    while log.len() > LOG_LINES {
        log.pop_front();
    }
}
