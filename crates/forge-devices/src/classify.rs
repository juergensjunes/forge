use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Bridge {
    /// Chip mit eingebautem USB (S2, S3, C3, C6, H2, P4): kein Wandler dazwischen.
    EspNative,
    Cp210x,
    Ch340,
    Ch9102,
    Ftdi,
    /// Nordic nRF52 mit UF2-/DFU-Bootloader (Seeed XIAO nRF52840): eigenes USB, kein ESP.
    Nrf52,
    /// Kein USB: ein Board im WLAN, das OTA-Updates anbietet.
    Network,
    Other,
}

/// Erkennt anhand von USB-IDs, ob ein Port zu einem ESP32 gehören kann. Das stört den Chip nicht.
/// Gibt Brücke, Wahrscheinlichkeit und eine Bezeichnung zurück.
pub fn classify(vid: u16, pid: u16) -> (Bridge, bool, &'static str) {
    match (vid, pid) {
        (0x303A, 0x1001) => (Bridge::EspNative, true, "ESP32 (USB-Serial/JTAG)"),
        (0x303A, _) => (Bridge::EspNative, true, "ESP32 (USB)"),
        (0x10C4, 0xEA60 | 0xEA70 | 0xEA71) => (Bridge::Cp210x, true, "CP210x UART"),
        (0x1A86, 0x7523 | 0x7522 | 0x5523) => (Bridge::Ch340, true, "CH340 UART"),
        (0x1A86, 0x55D2..=0x55D4) => (Bridge::Ch9102, true, "CH9102 UART"),
        (0x0403, 0x6001 | 0x6010 | 0x6014 | 0x6015) => (Bridge::Ftdi, true, "FTDI UART"),
        (0x2886, 0x0045 | 0x8045 | 0x8044 | 0x0044) => (Bridge::Nrf52, true, "XIAO nRF52840"),
        (0x2886, _) => (Bridge::Nrf52, true, "Seeed XIAO"),
        _ => (Bridge::Other, false, "Serielle Schnittstelle"),
    }
}

/// Die USB-Seriennummer von ESP-Chips mit eigenem USB ist ihre MAC-Adresse.
pub fn mac_from_serial(serial: &str) -> Option<String> {
    let s = serial.trim();
    let parts: Vec<&str> = s.split(':').collect();
    (parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())))
    .then(|| s.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_esp_bridges_are_recognised() {
        assert_eq!(classify(0x303A, 0x1001).0, Bridge::EspNative);
        assert_eq!(classify(0x10C4, 0xEA60).0, Bridge::Cp210x);
        assert_eq!(classify(0x1A86, 0x7523).0, Bridge::Ch340);
        assert_eq!(classify(0x1A86, 0x55D4).0, Bridge::Ch9102);
        assert!(classify(0x0403, 0x6001).1);
    }

    #[test]
    fn xiao_nrf52840_is_recognised() {
        assert_eq!(classify(0x2886, 0x8045).0, Bridge::Nrf52);
    }

    #[test]
    fn unrelated_devices_are_not_candidates() {
        // Arduino Uno, Raspberry Pi Pico
        assert!(!classify(0x2341, 0x0043).1);
        assert!(!classify(0x2E8A, 0x000A).1);
    }

    #[test]
    fn mac_is_taken_from_native_usb_serials_only_when_it_looks_like_one() {
        assert_eq!(
            mac_from_serial("7C:DF:A1:12:34:56").as_deref(),
            Some("7c:df:a1:12:34:56")
        );
        assert_eq!(mac_from_serial("0001"), None);
        assert_eq!(mac_from_serial("7C:DF:A1:12:34"), None);
    }
}
