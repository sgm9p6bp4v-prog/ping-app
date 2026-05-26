# Ping Output Fixtures

Golden samples fuer Parser-Charakterisierungstests (Sprint 1).

## Quellen

| Datei | Quelle | Zweck |
|-------|--------|-------|
| `macos_success_en_clean.txt` | echtes `ping -c 1 8.8.8.8` auf macOS 14 (en_US) | Erfolg, eine RTT-Linie mit `time=` |
| `macos_success_en.txt` | echtes `ping -c 1 -W 2 8.8.8.8` auf macOS | **macOS-Bug**: `-W 2` heisst auf macOS 2 ms (nicht 2 s) → Reply ausserhalb Wartezeit, kein `time=` Line. Francescos Parser gibt faelschlich "No response" zurueck obwohl Packet ankam. |
| `macos_timeout_en.txt` | echtes `ping -c 1 -W 2 192.0.2.1` (TEST-NET, RFC 5737) | Echter Timeout |
| `macos_dns_fail_en.txt` | echtes `ping -c 1 -W 2 host.nonexistent.local` | DNS-Aufloesung schlaegt fehl |
| `linux_success_en.txt` | hand-crafted, basiert auf iputils-ping Ubuntu/Debian | Linux EN-Erfolg (Ziel-Plattform) |
| `linux_timeout_en.txt` | hand-crafted | Linux EN-Timeout |
| `linux_unreachable_en.txt` | hand-crafted | Linux EN-Unreachable (`Destination Host Unreachable`) |
| `linux_success_it.txt` | hand-crafted, italienische Locale (`LC_ALL=it_IT.UTF-8`) | Italienisches Linux-Locale-Output (`tempo=`, `ricevuti`). Francescos Parser hat Italienisch nur im Windows-Branch — Linux/IT bleibt **un-erkannt** (Bug). |

## Wann neu generieren?

Wenn Ziel-Plattform sich aendert (z.B. neue Debian-Version) oder Locales hinzukommen. Echte Outputs sind reproduzierbarer als hand-crafted — wo moeglich `ping -c 1 <host> > sample.txt` ausfuehren.

## Was die Tests zeigen sollen

1. Welche Outputs der **aktuelle** Parser korrekt parst.
2. Welche Outputs er **falsch** parst (z.B. macOS short-wait, Italian Linux).
3. Baseline-Behaviour bevor Sprint 2 den Parser refactored.
