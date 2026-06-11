# Smoke runbook — F-OFF-107 certify veicolo pending (PR2)

**Stato: ESEGUITO E PASS 8/8 — 2026-06-11** (web prod
`app.garageos.aifollyadvisor.com`, bundle deployato da #191; deploy run
27337064823 success 09:23 UTC). Esiti in fondo.

Ambiente: web officine su prod (Vite dev locale puntato all'API prod va bene,
come per F-OFF-102). Utente officina: super_admin Giuseppe o un mechanic.

**Fixture**: veicolo pending lasciato in prod dallo smoke F-CLI-104 PR1 —
VIN `1M8GDM9AXKP042788`, proprietario cliente1
(`matulamichele+cliente1@gmail.com`). Recuperare targa/id via SQL editor se
serve: `SELECT id, plate FROM vehicles WHERE vin = '1M8GDM9AXKP042788';`

## Steps

- [x] **a. Ricerca pending** — cerca per VIN `1M8GDM9AXKP042788` (o per targa):
      la riga compare con badge ambra "Pending" (il pending è trovabile senza
      filtri, BR-150 search).
- [x] **b. Scheda veicolo** — aprendo la scheda: badge Pending nell'header,
      banner ambra "Veicolo pre-registrato dal cliente, in attesa di
      certificazione" con bottone "Certifica veicolo". GO-code assente
      nell'header. "Stampa tag" disabilitato (BR-026, gated su certified).
- [x] **c. Dialog precompilato** — click "Certifica veicolo": campi
      precompilati coi dati della pre-registrazione (VIN, targa, marca,
      modello, anno, tipo, alimentazione); submit **disabilitato** finché lo
      switch "Ho visionato il libretto di circolazione" è off (BR-004).
- [x] **d. Certifica con correzione** — correggi un campo non-VIN (es.
      versione o anno), attiva lo switch, submit → toast verde "Veicolo
      certificato — codice GO-XXX-XXXX".
- [x] **e. Scheda aggiornata** — senza reload manuale: badge "Certificato",
      GO-code nell'header, correzione visibile, "Stampa tag" abilitato
      (scarica il PDF per conferma BR-026). "Trasferisci proprietà" ora
      visibile (veicolo certified con ownership).
- [x] **f. Ri-certify respinto** — ri-cerca il veicolo: badge certificato,
      banner assente. (Opzionale via curl: POST certify di nuovo → 422
      `vehicle.certification.not_pending`.)
- [x] **g. Lato cliente (mobile, chiusura arco F-CLI-104)** — su Expo Go con
      account cliente1: il veicolo mostra il GO-code, badge/banner "In attesa
      di certificazione" spariti.
- [x] **h. Audit** — SQL editor: `SELECT action, user_id, created_at FROM
      access_logs WHERE vehicle_id = '<id>' ORDER BY created_at DESC LIMIT 3;`
      → riga `update` dell'utente certificatore. E sul veicolo:
      `certified_by_tenant_id` valorizzato, `certified_at` recente.

## Post-smoke

- ✅ Veicolo certificato aggiunto alla lista pulizia DB prod cumulata:
  `docs/superpowers/runbooks/prod-db-cleanup.md`.
- ✅ Esito annotato sotto.

## Note

- La notifica push+email al cliente alla certificazione è DIFFERITA
  (`TODO(F-CLI-notifications)`, deviazione BR-004 approvata in spec) — non
  aspettarsi notifiche allo step d.

## Esiti

**PASS 8/8 — 2026-06-11.** Web officine direttamente su prod
(`app.garageos.aifollyadvisor.com`, non Vite locale); mobile step g su Expo Go
sideloaded (Xiaomi `CI659HAE8LSW6H5L`, Metro `--offline` + `adb reverse`),
account cliente1. Audit step h via Supabase SQL editor.

Dati della certificazione:

- Vehicle id `4a153c86-1254-4b49-8ac0-709c55e2b9d0`, VIN
  `1M8GDM9AXKP042788`, targa `AB123CD`, GO-code assegnato **GO-657-RREH**.
- `certified_by_tenant_id` = `e1b72920-c2f6-4eb2-b31c-d0ad33108308`,
  `certified_at` = 2026-06-11 09:36:40 UTC.
- Access log: riga `update` (certify) ore 09:36:40 + `search_match` (step a)
  ore 09:31:09, entrambe user `921fd1e8-1aaf-44df-a2cc-09bbe2d080f6`.
- Step e: PDF tag scaricato con GO-657-RREH (BR-026 confermata); "Trasferisci
  proprietà" comparso post-certify senza reload.
- Step g: lato cliente il GO-code è visibile e badge/banner pending spariti →
  **arco F-CLI-104 → F-OFF-107 chiuso anche lato smoke**.

Deviazioni (minori, nessun FAIL):

- Step d eseguito **senza correzione campi** (submit coi dati della
  pre-registrazione): il sub-check "correzione visibile" dello step e è
  saltato. Path corrections coperto dai test di integrazione di #191.
- Curl opzionale step f (422 `vehicle.certification.not_pending`) non
  eseguito; guard coperto dal test concurrent double-certify.

Osservazione (non un finding, candidato follow-up): la targa `AB123CD` del
veicolo pre-registrato duplica quella del veicolo demo usato nello smoke
F-OFF-102 per il dialog targa-duplicata; il certify senza correzione targa
non ripropone il soft-warning duplicato (il check F-OFF-102 vive nel form di
censimento). In prod ora ci sono due veicoli con la stessa targa — si risolve
con la pulizia DB (il veicolo smoke viene eliminato).
