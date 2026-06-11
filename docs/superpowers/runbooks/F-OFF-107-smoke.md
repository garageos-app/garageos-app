# Smoke runbook — F-OFF-107 certify veicolo pending (PR2)

**Stato: DA ESEGUIRE** (post-merge + auto-deploy di main).

Ambiente: web officine su prod (Vite dev locale puntato all'API prod va bene,
come per F-OFF-102). Utente officina: super_admin Giuseppe o un mechanic.

**Fixture**: veicolo pending lasciato in prod dallo smoke F-CLI-104 PR1 —
VIN `1M8GDM9AXKP042788`, proprietario cliente1
(`matulamichele+cliente1@gmail.com`). Recuperare targa/id via SQL editor se
serve: `SELECT id, plate FROM vehicles WHERE vin = '1M8GDM9AXKP042788';`

## Steps

- [ ] **a. Ricerca pending** — cerca per VIN `1M8GDM9AXKP042788` (o per targa):
      la riga compare con badge ambra "Pending" (il pending è trovabile senza
      filtri, BR-150 search).
- [ ] **b. Scheda veicolo** — aprendo la scheda: badge Pending nell'header,
      banner ambra "Veicolo pre-registrato dal cliente, in attesa di
      certificazione" con bottone "Certifica veicolo". GO-code assente
      nell'header. "Stampa tag" disabilitato (BR-026, gated su certified).
- [ ] **c. Dialog precompilato** — click "Certifica veicolo": campi
      precompilati coi dati della pre-registrazione (VIN, targa, marca,
      modello, anno, tipo, alimentazione); submit **disabilitato** finché lo
      switch "Ho visionato il libretto di circolazione" è off (BR-004).
- [ ] **d. Certifica con correzione** — correggi un campo non-VIN (es.
      versione o anno), attiva lo switch, submit → toast verde "Veicolo
      certificato — codice GO-XXX-XXXX".
- [ ] **e. Scheda aggiornata** — senza reload manuale: badge "Certificato",
      GO-code nell'header, correzione visibile, "Stampa tag" abilitato
      (scarica il PDF per conferma BR-026). "Trasferisci proprietà" ora
      visibile (veicolo certified con ownership).
- [ ] **f. Ri-certify respinto** — ri-cerca il veicolo: badge certificato,
      banner assente. (Opzionale via curl: POST certify di nuovo → 422
      `vehicle.certification.not_pending`.)
- [ ] **g. Lato cliente (mobile, chiusura arco F-CLI-104)** — su Expo Go con
      account cliente1: il veicolo mostra il GO-code, badge/banner "In attesa
      di certificazione" spariti.
- [ ] **h. Audit** — SQL editor: `SELECT action, user_id, created_at FROM
      access_logs WHERE vehicle_id = '<id>' ORDER BY created_at DESC LIMIT 3;`
      → riga `update` dell'utente certificatore. E sul veicolo:
      `certified_by_tenant_id` valorizzato, `certified_at` recente.

## Post-smoke

- Aggiungere il veicolo certificato alla lista pulizia DB prod (insieme a
  F-OFF-102 `19bd3b73`/`ZZ999ZZ`, dati smoke transfer, veicolo di Pippo
  Baudo): ora ha GO-code e ownership reali di cliente1.
- Annotare qui l'esito (PASS/FAIL + data + anomalie).

## Note

- La notifica push+email al cliente alla certificazione è DIFFERITA
  (`TODO(F-CLI-notifications)`, deviazione BR-004 approvata in spec) — non
  aspettarsi notifiche allo step d.
