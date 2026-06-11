# Runbook — Pulizia DB prod cumulata (dati smoke)

**Stato: DA ESEGUIRE** (operator-driven, Supabase SQL editor come
`postgres`/superuser — `garageos_app` non ha policy DELETE, RLS default-deny).

Lista cumulata dei dati lasciati in prod dagli smoke test, aggiornata al
2026-06-11 (post smoke F-OFF-107). Eseguire le sezioni in ordine; ogni
sezione è indipendente e idempotente (re-run senza effetti se già pulita).

## Inventario

| # | Origine | Dati | Azione |
|---|---|---|---|
| 1 | Smoke F-OFF-102 (2026-06-09) | Veicolo `19bd3b73-8784-4769-80db-1465ef0db45a` (targa `ZZ999ZZ`, GO-744-DYGY) + cliente `smoketest.foff102@example.com` + ownership/CTR/access_logs | DELETE |
| 2 | Smoke F-CLI-104/F-OFF-107 (2026-06-11) | Veicolo `4a153c86-1254-4b49-8ac0-709c55e2b9d0` (VIN `1M8GDM9AXKP042788`, targa `AB123CD` — duplica la targa del veicolo demo, GO-657-RREH) + ownership cliente1 + access_logs + eventuale riga `vehicle_tag_prints` (stampa tag step e) | DELETE (cliente1 RESTA: account di test riusato) |
| 3 | Smoke F-CLI-401 PR5 transfer (2026-06-10) | 3 righe `vehicle_transfers` (1 `completed` `TR-GMHT-FKGB`, 2 `rejected`) sul veicolo del green path | DELETE (decisione: vedi sezione 3) |
| 4 | Smoke F-CLI-401 PR5 transfer (2026-06-10) | Il veicolo del green path è ora di proprietà di Pippo Baudo (customer `731b3cb3`, `matulamichele+b2cpwd@gmail.com`) — giro di ritorno mai eseguito | **DECISIONE UTENTE**: lasciare così o riportarlo a cliente1 |

NON toccare: account cliente1, Pippo Baudo (`731b3cb3`), `signup-smoke-001`
(pool Cognito clienti), seed demo officina Giuseppe.

## Sezione 1+2 — Veicoli smoke (DELETE completo)

FK-safe order: figli → ownership → veicolo. I DELETE su tabelle dove non ci
si aspetta righe (interventions, deadlines, ...) sono difensivi: se
eliminano qualcosa, indagare prima di proseguire (girare prima le SELECT di
verifica sotto).

```sql
-- Verifica preliminare: cosa esiste per i due veicoli
SELECT 'vehicle_ownerships' t, count(*) FROM vehicle_ownerships WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'vehicle_transfers', count(*) FROM vehicle_transfers WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'interventions', count(*) FROM interventions WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'private_interventions', count(*) FROM private_interventions WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'deadlines', count(*) FROM deadlines WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'access_logs', count(*) FROM access_logs WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'vehicle_tag_prints', count(*) FROM vehicle_tag_prints WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0')
UNION ALL SELECT 'invitations', count(*) FROM invitations WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0');

-- Atteso: solo ownership (1+1), access_logs (qualche riga),
-- vehicle_tag_prints (0 o 1 per il tag stampato allo step e F-OFF-107).
-- interventions/private_interventions/deadlines/transfers/invitations = 0.

BEGIN;

DELETE FROM access_logs        WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0');
DELETE FROM vehicle_tag_prints WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0');
DELETE FROM vehicle_ownerships WHERE vehicle_id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0');
DELETE FROM vehicles           WHERE id IN ('19bd3b73-8784-4769-80db-1465ef0db45a','4a153c86-1254-4b49-8ac0-709c55e2b9d0');

-- Cliente smoke F-OFF-102 (solo lui: cliente1 NON si tocca)
DELETE FROM email_verifications WHERE customer_id IN (SELECT id FROM customers WHERE email = 'smoketest.foff102@example.com');
DELETE FROM customer_tenant_relations WHERE customer_id IN (SELECT id FROM customers WHERE email = 'smoketest.foff102@example.com');
DELETE FROM customers WHERE email = 'smoketest.foff102@example.com';

COMMIT;
```

Nota: `smoketest.foff102` non ha utenza Cognito (creato dal form officina
con `sendInvitationEmail=false`) — nessuna pulizia pool Cognito necessaria.

## Sezione 3 — Righe transfer smoke

```sql
-- Verifica: devono essere esattamente 3 (1 completed TR-GMHT-FKGB, 2 rejected)
SELECT id, transfer_code, status, created_at FROM vehicle_transfers
WHERE transfer_code = 'TR-GMHT-FKGB' OR status = 'rejected'
ORDER BY created_at;

-- Se l'output è coerente (3 righe, date 2026-06-10):
DELETE FROM vehicle_transfers WHERE id IN ('<id1>','<id2>','<id3>');
```

Trade-off: le 3 righe sono storia reale del flusso (audit), ma generate da
smoke. Eliminarle lascia il DB demo pulito; tenerle non costa nulla. Default
proposto: eliminarle insieme al resto.

## Sezione 4 — Veicolo del green path a Pippo Baudo (decisione)

Il veicolo trasferito nello smoke F-CLI-401 PR5 appartiene ora a Pippo Baudo
(customer `731b3cb3`). Opzioni:

- **(a) Lasciare così** — Pippo Baudo è un account di test legittimo; lo
  stato è consistente (swap atomico riuscito). Zero rischio.
- **(b) Giro di ritorno via app** — nuovo transfer da B verso cliente1 con
  il flusso reale (genera nuove righe `vehicle_transfers` da ripulire poi).
- **(c) Swap manuale SQL** — sconsigliato: replica a mano la logica di
  `confirmTransferSwap` (close ownership attiva + insert nuova) con rischio
  di violare `uq_ownership_vehicle_active`.

Default proposto: **(a)** — nessuna azione.

## Post-esecuzione

- Annotare qui data di esecuzione ed esito delle SELECT di verifica.
- Aggiornare il checkpoint di memoria (pulizia DB prod non più pending).
