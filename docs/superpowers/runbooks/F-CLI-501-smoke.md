# F-CLI-501 — Export PDF storico veicolo (cliente) — Smoke runbook

Operator-driven post-deploy verification for F-CLI-501 PR2 (mobile export button).

**Tipo:** manuale device, post-deploy. BLOCKER prima di considerare F-CLI-501 completo.

### Pre-condizioni

PR1 API (`GET /v1/me/vehicles/:id/export.pdf`) deployata in prod e verde + questa PR (mobile)
buildata su device (Expo Go SDK-matched o build EAS). Account cliente con almeno un veicolo posseduto
(`VehicleOwnership` attivo). Idealmente quel veicolo ha: interventi officina di **due tenant diversi**
(cross-tenant BR-150), un intervento `cancelled`, almeno un intervento con `internal_notes`, e — per il
multi-pagina — abbastanza interventi da superare una pagina A4. Tenere a portata un secondo veicolo
**senza** interventi officina per l'empty-state.

### Step a — Export base (veicolo posseduto)

1. Login cliente → apri il dettaglio di un veicolo posseduto.
2. Tab **Dati tecnici** → in fondo, premi **"Esporta PDF storico"**.

Atteso: il bottone mostra "Generazione PDF…" + spinner; al termine il PDF si apre nel
browser/viewer di sistema (fallback `Linking.openURL` sul presigned URL — `expo-file-system`/
`expo-sharing` non installati, CLAUDE.md §7). Nessun messaggio di errore inline.

### Step b — Intestazione veicolo-centrica

1. Ispeziona l'intestazione del PDF.

Atteso: header GarageOS-branded; marca/modello · targa · cod. GarageOS; VIN/anno/alimentazione (se
presenti). **NESSUN nome del proprietario** (documento veicolo-centrico). Se il veicolo ha interventi
di più officine, ognuno è etichettato `officina · città`.

### Step c — Accenti italiani

1. Individua nel PDF testo con caratteri accentati (à è ì ò ù).

Atteso: renderizzati correttamente — nessun `?` o tofu.

### Step d — Esclusioni (note interne + annullati)

1. Verifica un intervento che ha `internal_notes` valorizzate.

Atteso: le note interne NON compaiono nel PDF.

2. Verifica che eventuali interventi `cancelled` del veicolo NON compaiano.

Atteso: solo interventi `active` + `disputed`; nessun annullato.

### Step e — Multi-pagina

1. Esporta un veicolo con molti interventi (storico > 1 pagina A4).

Atteso: PDF su più pagine; footer "Pagina N di M" corretto e coerente su ogni pagina; nessun
intervento spezzato a metà (salvo descrizioni che da sole superano la pagina).

### Step f — Empty-state

1. Esporta un veicolo posseduto **senza** interventi officina.

Atteso: PDF valido con riga "Nessun intervento officina registrato".

### Step g — Errore ownership

1. (Opzionale) Se riproducibile, esercita l'export su un veicolo non più posseduto
   (`endedAt != null`).

Atteso: messaggio inline "Veicolo non trovato" (mapping `me.vehicle.not_found`); nessun crash, il PDF
non si apre.
