# LLM Context — client--francesco-ping-app

## Was ist das?
Fremd-Repo eines Kollegen (Francesco). Wir wurden eingeladen Code zuzuliefern.
Unser Repo ist ein Arbeits-Clone — Francescos `origin` bleibt Single Source of Truth.

## Was ist es NICHT?
- Kein Kundenprojekt im klassischen Sinne (kein Vertrag, kein Deploy bei uns).
- Keine Edge-Integration, keine Woodpecker-Pipeline, kein eigener Health-Endpoint.
- Kein Cross-Repo-Coupling mit unserer Fleet — depends_on bewusst leer.

## Arbeitsmodus
- Branches: `feat/varga-*`, `fix/varga-*` (klar als externer Beitrag markiert).
- Push auf `main`: NUR via PR und nach Francescos Freigabe.
- Repo derzeit leer (frischer GitHub-Init). Erst sobald Francesco Initial-Commit pusht:
  - Tech-Stack in `repo-contract.yaml` befuellen
  - `commands.test` + `commands.smoke` ausarbeiten
  - Dieses Dokument um Architektur-Notizen ergaenzen

## Offene Punkte
Siehe `meta/open-questions.md`.
