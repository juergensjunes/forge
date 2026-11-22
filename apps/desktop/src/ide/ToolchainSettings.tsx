import { Badge, Button } from "@forge/ui";
import { t } from "../i18n/de";
import { useHardware } from "../lib/hardware";
import { useStore } from "../lib/store";
import { version_cmp } from "../lib/versions";
import "../hardware.css";

/** Einstellungen: Stand des ESP32-Cores und Aktualisierung. */
export function ToolchainSection() {
  const status = useHardware((s) => s.toolchain);
  const busy = useHardware((s) => s.coreUpgrading);
  const setup = useHardware((s) => s.setup);
  const upgrade = useHardware((s) => s.upgradeCore);
  const setupNrf = useHardware((s) => s.runSetupNrf);
  const setDialog = useStore((s) => s.setDialog);
  if (!status || !status.arduinoCli) return null;

  const installed = status.esp32Core;
  const latest = status.esp32CoreLatest ?? null;
  const outdated = !!installed && !!latest && version_cmp(latest, installed) > 0;

  return (
    <section className="settings-group" aria-label={t.updates.title}>
      <h3 className="settings-heading">{t.updates.title}</h3>
      <div className="form">
        <div className="settings-actions">
          <span>{t.updates.core}</span>
          {installed && !outdated ? <Badge tone="success" icon="check">{t.updates.coreCurrent(installed)}</Badge> : null}
          {outdated ? <Badge tone="warning" icon="warning">{t.updates.coreOutdated(installed!, latest!)}</Badge> : null}
          {!installed ? <Badge tone="warning" icon="warning">{t.updates.coreMissing}</Badge> : null}
        </div>
        <div className="settings-actions">
          {outdated ? (
            <Button variant="secondary" size="sm" busy={busy} onClick={() => void upgrade()}>
              {busy ? t.updates.coreUpgrading : t.updates.coreUpgrade}
            </Button>
          ) : null}
          {!installed ? (
            <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "toolchain" })}>
              {t.updates.setup}
            </Button>
          ) : null}
          {busy ? <span className="settings-note">{setup.line.slice(0, 60)}</span> : null}
        </div>
        <div className="settings-actions">
          <span>{t.updates.nrfCore}</span>
          {status.nrf52Core ? <Badge tone="success" icon="check">{t.updates.coreCurrent(status.nrf52Core)}</Badge> : <Badge tone="warning" icon="warning">{t.updates.coreMissing}</Badge>}
        </div>
        <div className="settings-actions">
          {!status.nrf52Core ? (
            <Button variant="secondary" size="sm" busy={setup.running} onClick={() => void setupNrf()}>
              {t.updates.nrfSetup}
            </Button>
          ) : null}
          {setup.running && !busy ? <span className="settings-note">{setup.line.slice(0, 60)}</span> : null}
        </div>
      </div>
    </section>
  );
}
