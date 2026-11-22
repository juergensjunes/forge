use crate::state::AppState;
use forge_toolchain::models::{BoardEntry, BoardOption};
use forge_toolchain::process::Stream;
use forge_toolchain::CancellationToken;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const ESP32_INDEX: &str = "https://espressif.github.io/arduino-esp32/package_esp32_index.json";
const ESP32_CORE: &str = "esp32:esp32";
const SEEED_INDEX: &str = "https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json";
/// Seeed-nRF52-Core (Adafruit-Bootloader) mit XIAO nRF52840 und Sense.
pub const NRF52_CORE: &str = "Seeeduino:nrf52";

/// Gehört der FQBN zum ESP32-Core? Alles andere flasht über das Upload-Rezept des Cores.
pub fn is_esp32_fqbn(fqbn: &str) -> bool {
    fqbn.starts_with("esp32:esp32:")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    pub arduino_cli: Option<String>,
    pub esp32_core: Option<String>,
    pub esptool: bool,
    pub error: Option<String>,
    /// Neueste Version des ESP32-Cores laut Paketliste.
    pub esp32_core_latest: Option<String>,
    /// Installierter Seeed-nRF52-Core (XIAO nRF52840).
    pub nrf52_core: Option<String>,
}

#[tauri::command]
pub async fn toolchain_status(state: State<'_, AppState>) -> Result<ToolchainStatus, String> {
    let cli = match state.toolchain.cli() {
        Ok(c) => c,
        Err(e) => {
            return Ok(ToolchainStatus {
                arduino_cli: None,
                esp32_core: None,
                esptool: false,
                error: Some(e),
                esp32_core_latest: None,
                nrf52_core: None,
            })
        }
    };
    let version = cli.version().await.ok();
    let cores = cli.cores().await.ok().unwrap_or_default();
    let nrf52_core = cores
        .iter()
        .find(|c| c.id == NRF52_CORE)
        .and_then(|c| c.installed.clone());
    let core_info = cores.into_iter().find(|c| c.id == ESP32_CORE);
    let core_latest = core_info.as_ref().and_then(|c| c.latest.clone());
    let core = core_info.and_then(|c| c.installed);
    let esptool = state.toolchain.esptool().await.is_ok();
    Ok(ToolchainStatus {
        arduino_cli: version,
        esp32_core: core,
        esptool,
        error: None,
        esp32_core_latest: core_latest,
        nrf52_core,
    })
}

#[derive(Serialize, Clone)]
struct Progress {
    line: String,
    fraction: Option<f32>,
}

/// Richtet den ESP32-Core ein: Espressif-Index eintragen, Index laden, Core installieren.
#[tauri::command]
pub async fn toolchain_setup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cli = state.toolchain.cli()?;
    let pct = Regex::new(r"(\d+(?:\.\d+)?)\s*%").map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let emit = |app: &AppHandle, line: &str| {
        let fraction = pct
            .captures(line)
            .and_then(|c| c[1].parse::<f32>().ok())
            .map(|p| p / 100.0);
        let _ = app.emit(
            "toolchain:progress",
            Progress {
                line: line.to_string(),
                fraction,
            },
        );
    };

    let _ = app.emit(
        "toolchain:progress",
        Progress {
            line: "Trage Espressif-Quelle ein".into(),
            fraction: None,
        },
    );
    cli.ensure_board_url(ESP32_INDEX)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "toolchain:progress",
        Progress {
            line: "Lade Paketliste".into(),
            fraction: None,
        },
    );
    cli.update_index(&cancel, |_, l| emit(&app, l))
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "toolchain:progress",
        Progress {
            line: "Installiere ESP32-Core".into(),
            fraction: None,
        },
    );
    cli.install_core(ESP32_CORE, &cancel, |s, l| {
        if s == Stream::Stdout || s == Stream::Stderr {
            emit(&app, l);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    state.toolchain.invalidate();
    Ok(())
}

/// Richtet den Seeed-nRF52-Core ein (XIAO nRF52840 / Sense): Seeed-Quelle eintragen, Index laden, Core installieren.
#[tauri::command]
pub async fn toolchain_setup_nrf(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cli = state.toolchain.cli()?;
    let pct = Regex::new(r"(\d+(?:\.\d+)?)\s*%").map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let emit = |app: &AppHandle, line: &str, f: Option<f32>| {
        let fraction = f.or_else(|| {
            pct.captures(line)
                .and_then(|c| c[1].parse::<f32>().ok())
                .map(|p| p / 100.0)
        });
        let _ = app.emit(
            "toolchain:progress",
            Progress {
                line: line.to_string(),
                fraction,
            },
        );
    };
    emit(&app, "Trage Seeed-Quelle ein", None);
    cli.ensure_board_url(SEEED_INDEX)
        .await
        .map_err(|e| e.to_string())?;
    emit(&app, "Lade Paketliste", None);
    cli.update_index(&cancel, |_, l| emit(&app, l, None))
        .await
        .map_err(|e| e.to_string())?;
    emit(&app, "Installiere Seeed-nRF52-Core", None);
    cli.install_core(NRF52_CORE, &cancel, |s, l| {
        if s == Stream::Stdout || s == Stream::Stderr {
            emit(&app, l, None);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    // Ohne diese Bibliothek gibt es auf dem XIAO kein `Serial` (USB-CDC läuft über TinyUSB).
    emit(&app, "Installiere Adafruit TinyUSB Library", None);
    cli.install_library("Adafruit TinyUSB Library", None, &cancel, |s, l| {
        if s == Stream::Stdout || s == Stream::Stderr {
            emit(&app, l, None);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    state.toolchain.invalidate();
    Ok(())
}

#[tauri::command]
pub async fn boards_list(state: State<'_, AppState>) -> Result<Vec<BoardEntry>, String> {
    let mut boards = state
        .toolchain
        .cli()?
        .boards("")
        .await
        .map_err(|e| e.to_string())?;
    // ESP32 zuerst, damit die Liste dort beginnt, wo die Nutzer suchen.
    boards.sort_by(|a, b| {
        let rank = |p: &str| match p {
            ESP32_CORE => 0,
            NRF52_CORE => 1,
            _ => 2,
        };
        rank(&a.platform)
            .cmp(&rank(&b.platform))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(boards)
}

#[tauri::command]
pub async fn board_options(
    state: State<'_, AppState>,
    fqbn: String,
) -> Result<Vec<BoardOption>, String> {
    state
        .toolchain
        .cli()?
        .board_options(&fqbn)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbuildStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub enabled: bool,
    /// Die Boards, für die fbuild bei uns baut.
    pub boards: Vec<String>,
}

pub fn fbuild_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dirs: Vec<std::path::PathBuf> = crate::store::tools_dir(app).into_iter().collect();
    forge_toolchain::fbuild::locate(&dirs)
}

#[tauri::command]
pub async fn fbuild_status(app: AppHandle) -> FbuildStatus {
    let path = fbuild_path(&app);
    let version = match &path {
        Some(p) => forge_toolchain::fbuild::version(p).await,
        None => None,
    };
    FbuildStatus {
        installed: path.is_some(),
        version,
        enabled: crate::store::build_settings(&app).fbuild_enabled,
        boards: vec!["ESP32 Dev Module".into()],
    }
}

#[tauri::command]
pub fn fbuild_set_enabled(app: AppHandle, enabled: bool) {
    let mut s = crate::store::build_settings(&app);
    s.fbuild_enabled = enabled;
    crate::store::set_build_settings(&app, &s);
}

/// Installiert fbuild in einer eigenen Python-Umgebung und lädt die Toolchain vor.
#[tauri::command]
pub async fn fbuild_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let dir =
        crate::store::tools_dir(&app).ok_or("Der Speicherort der App ist nicht erreichbar.")?;
    let cancel = CancellationToken::new();
    let pct = Regex::new(r"\((\d+)%\)|(\d+(?:\.\d+)?)\s*%").map_err(|e| e.to_string())?;
    let say = |app: &AppHandle, line: &str| {
        let fraction = pct
            .captures(line)
            .and_then(|c| c.get(1).or(c.get(2)))
            .and_then(|m| m.as_str().parse::<f32>().ok())
            .map(|p| p / 100.0);
        let _ = app.emit(
            "toolchain:progress",
            Progress {
                line: line.to_string(),
                fraction,
            },
        );
    };
    let bin = forge_toolchain::fbuild::install(&dir, &cancel, |l| say(&app, l))
        .await
        .map_err(|e| e.to_string())?;
    let board =
        forge_toolchain::fbuild::board_for("esp32:esp32:esp32").ok_or("Kein Board für fbuild.")?;
    let work = state.toolchain.cache_base().join("fbuild-prefetch");
    forge_toolchain::fbuild::prefetch(&bin, &work, &board, &cancel, |l| say(&app, l))
        .await
        .map_err(|e| e.to_string())
}

/// Aktualisiert den ESP32-Core auf die neueste Version. Fortschritt kommt über `toolchain:progress`.
#[tauri::command]
pub async fn core_upgrade(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cli = state.toolchain.cli()?;
    let pct = Regex::new(r"(\d+(?:\.\d+)?)\s*%").map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let _ = app.emit(
        "toolchain:progress",
        Progress {
            line: "Aktualisiere ESP32-Core".into(),
            fraction: None,
        },
    );
    cli.upgrade_core(ESP32_CORE, &cancel, |_, l| {
        let fraction = pct
            .captures(l)
            .and_then(|c| c[1].parse::<f32>().ok())
            .map(|p| p / 100.0);
        let _ = app.emit(
            "toolchain:progress",
            Progress {
                line: l.to_string(),
                fraction,
            },
        );
    })
    .await
    .map_err(|e| e.to_string())?;
    state.toolchain.invalidate();
    Ok(())
}

/// Lädt die Paketliste neu, wenn sie älter als 24 Stunden ist. Gibt `true` zurück, wenn aktualisiert wurde.
#[tauri::command]
pub async fn toolchain_refresh_index(state: State<'_, AppState>) -> Result<bool, String> {
    let cli = state.toolchain.cli()?;
    let data = state.toolchain.data_dir().await?;
    let fresh = forge_toolchain::cli::index_age(&data)
        .is_some_and(|a| a < std::time::Duration::from_secs(24 * 3600));
    if fresh {
        return Ok(false);
    }
    cli.update_index(&CancellationToken::new(), |_, _| {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}
