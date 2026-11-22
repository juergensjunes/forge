use crate::{CancellationToken, Error, Result};
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Default)]
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Captured {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// Umgebung für Kindprozesse. GUI-Apps starten mit minimalem PATH, daher ergänzen wir die üblichen Orte.
pub fn base_env() -> Vec<(OsString, OsString)> {
    let mut path = String::from(
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    if let Some(old) = std::env::var_os("PATH") {
        path = format!("{}:{}", old.to_string_lossy(), path);
    }
    if let Some(dir) = python_shim_dir(&path) {
        path = format!("{path}:{}", dir.to_string_lossy());
    }
    vec![
        ("PATH".into(), path.into()),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
    ]
}

/// macOS kennt nur `python3`, die Post-Build-Schritte mancher Cores (nRF52: DFU-Paket) rufen aber `python` auf.
/// Fehlt `python`, legen wir einmal ein Skript an, das `python3` aufruft, und hängen dessen Ordner hinten an den PATH.
fn python_shim_dir(path: &str) -> Option<std::path::PathBuf> {
    static DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        if path.split(':').any(|d| Path::new(d).join("python").exists()) {
            return None;
        }
        let py3 = path
            .split(':')
            .map(|d| Path::new(d).join("python3"))
            .find(|p| p.exists())?;
        let dir = std::path::PathBuf::from(std::env::var_os("HOME")?)
            .join("Library/Caches/Forge/shims");
        std::fs::create_dir_all(&dir).ok()?;
        let link = dir.join("python");
        // Kein Symlink: der Stub unter /usr/bin/python3 wählt sein Werkzeug nach dem Aufrufnamen.
        let script = format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", py3.to_string_lossy());
        if std::fs::read_to_string(&link).ok().as_deref() != Some(script.as_str()) {
            let _ = std::fs::remove_file(&link);
            std::fs::write(&link, script).ok()?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&link, std::fs::Permissions::from_mode(0o755)).ok()?;
        }
        Some(dir)
    })
    .clone()
}

fn command(
    program: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    locale: &str,
    extra_env: &[(&str, &str)],
) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in base_env() {
        cmd.env(k, v);
    }
    cmd.env("LC_ALL", locale);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd
}

fn tool_name(program: &Path) -> String {
    program
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Führt einen Befehl aus und sammelt die Ausgabe.
pub async fn capture(
    program: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    locale: &str,
    timeout: Option<Duration>,
) -> Result<Captured> {
    let child = command(program, args, cwd, locale, &[])
        .spawn()
        .map_err(|source| Error::Spawn {
            tool: tool_name(program),
            source,
        })?;
    let wait = child.wait_with_output();
    let out = match timeout {
        Some(t) => tokio::time::timeout(t, wait)
            .await
            .map_err(|_| Error::Timeout(tool_name(program)))??,
        None => wait.await?,
    };
    Ok(Captured {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Zerlegt einen Bytestrom an `\n` und `\r`. esptool überschreibt Fortschrittszeilen mit `\r`.
async fn pump<R: AsyncRead + Unpin>(
    mut reader: R,
    stream: Stream,
    tx: mpsc::UnboundedSender<(Stream, String)>,
) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    let _ = tx.send((stream, String::from_utf8_lossy(&line).into_owned()));
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
    if !line.is_empty() {
        let _ = tx.send((stream, String::from_utf8_lossy(&line).into_owned()));
    }
}

/// Führt einen Befehl aus und meldet jede Ausgabezeile sofort. Bricht ab, wenn `cancel` ausgelöst wird.
pub async fn stream(
    program: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    locale: &str,
    cancel: &CancellationToken,
    on_line: impl FnMut(Stream, &str),
) -> Result<Option<i32>> {
    stream_with_env(program, args, cwd, locale, &[], cancel, on_line).await
}

/// Wie `stream`, mit zusätzlichen Umgebungsvariablen nur für diesen Aufruf.
pub async fn stream_with_env(
    program: &Path,
    args: &[OsString],
    cwd: Option<&Path>,
    locale: &str,
    extra_env: &[(&str, &str)],
    cancel: &CancellationToken,
    mut on_line: impl FnMut(Stream, &str),
) -> Result<Option<i32>> {
    let mut child = command(program, args, cwd, locale, extra_env)
        .spawn()
        .map_err(|source| Error::Spawn {
            tool: tool_name(program),
            source,
        })?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Some(o) = child.stdout.take() {
        tokio::spawn(pump(o, Stream::Stdout, tx.clone()));
    }
    if let Some(e) = child.stderr.take() {
        tokio::spawn(pump(e, Stream::Stderr, tx.clone()));
    }
    drop(tx);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                return Err(Error::Cancelled);
            }
            msg = rx.recv() => match msg {
                Some((s, line)) => on_line(s, &line),
                None => break,
            },
        }
    }
    let status = child.wait().await?;
    Ok(status.code())
}

pub fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capture_collects_output_and_exit_code() {
        let r = capture(
            Path::new("/bin/sh"),
            &os(&["-c", "echo hallo; echo fehler >&2; exit 3"]),
            None,
            "C",
            None,
        )
        .await
        .unwrap();
        assert_eq!(r.code, Some(3));
        assert_eq!(r.stdout.trim(), "hallo");
        assert_eq!(r.stderr.trim(), "fehler");
    }

    #[tokio::test]
    async fn stream_splits_on_carriage_returns() {
        let mut lines = Vec::new();
        let code = stream(
            Path::new("/bin/sh"),
            &os(&["-c", "printf 'a 10 %%\\ra 50 %%\\ra 100 %%\\nfertig\\n'"]),
            None,
            "C",
            &CancellationToken::new(),
            |_, l| lines.push(l.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(lines, ["a 10 %", "a 50 %", "a 100 %", "fertig"]);
    }

    #[tokio::test]
    async fn stream_can_be_cancelled() {
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            t2.cancel();
        });
        let started = std::time::Instant::now();
        let r = stream(
            Path::new("/bin/sh"),
            &os(&["-c", "sleep 30"]),
            None,
            "C",
            &token,
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(Error::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
