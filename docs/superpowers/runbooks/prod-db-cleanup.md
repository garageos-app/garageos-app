# Runbook — Pulizia DB prod cumulata (dati smoke)

**Stato: SUPERATO — FULL RESET ESEGUITO 2026-06-12.** Su richiesta
dell'utente la pulizia selettiva è stata sostituita da un **reset completo
di prod**: TRUNCATE di tutte le tabelle applicative (preservati
`_prisma_migrations` e i 12 `intervention_types` di sistema, ri-seedati),
svuotati i 2 pool Cognito attivi e il bucket `garageos-production-attachments`
(19 oggetti), eliminati gli 8 pool Cognito orfani di vecchi deploy.
Ricreati: **Officina Matula** (tenant `4d286c7b-25aa-4ad1-91d6-e98affc49ad5`,
SA `matulamichele@gmail.com`, mechanic `matulamichele+meccanico1@gmail.com`)
e **Officina Soriente** (tenant `b0cc6b9d-6176-483b-a7cf-8453ab66eba8`,
SA `luca@soriente.it`, mechanic `luca+meccanico1@soriente.it`), 1 location
primaria ciascuna, P.IVA/indirizzi placeholder. Password mai emesse: ogni
utente fa il bootstrap con "Password dimenticata" sulla web app (F-OFF-005).
Esecuzione via `scripts/db-cleanup-query.mjs` + `scripts/rebuild-tenants.mjs`
(operator-only, non committati) con `DIRECT_URL` superuser locale.
Le sezioni sotto restano come riferimento storico del metodo selettivo.

**Stato precedente: DA ESEGUIRE** (operator-driven, Supabase SQL editor come
`postgres`/superuser — `garageos_app` non ha policy DELETE, RLS default-deny).

Lista cumulata dei dati lasciati in prod dagli smoke test, aggiornata al
2026-06-12 (post smoke email e2e + #200). Eseguire le sezioni in ordine; ogni
sezione è indipendente e idempotente (re-run senza effetti se già pulita).

## Inventario

| # | Origine | Dati | Azione |
|---|---|---|---|
| 1 | Smoke F-OFF-102 (2026-06-09) | Veicolo `19bd3b73-8784-4769-80db-1465ef0db45a` (targa `ZZ999ZZ`, GO-744-DYGY) + cliente `smoketest.foff102@example.com` + ownership/CTR/access_logs | DELETE |
| 2 | Smoke F-CLI-104/F-OFF-107 (2026-06-11) | Veicolo `4a153c86-1254-4b49-8ac0-709c55e2b9d0` (VIN `1M8GDM9AXKP042788`, targa `AB123CD` — duplica la targa del veicolo demo, GO-657-RREH) + ownership cliente1 + access_logs + eventuale riga `vehicle_tag_prints` (stampa tag step e) | DELETE (cliente1 RESTA: account di test riusato) |
| 3 | Smoke F-CLI-401 PR5 transfer (2026-06-10) | 3 righe `vehicle_transfers` (1 `completed` `TR-GMHT-FKGB`, 2 `rejected`) sul veicolo del green path | DELETE (decisione: vedi sezione 3) |
| 4 | Smoke F-CLI-401 PR5 transfer (2026-06-10) | Il veicolo del green path è ora di proprietà di Pippo Baudo (customer `731b3cb3`, `matulamichele+b2cpwd@gmail.com`) — giro di ritorno mai eseguito | **DECISIONE UTENTE**: lasciare così o riportarlo a cliente1 |
| 5 | Smoke verify-email Resend (2026-06-11, #199) | Customer `2d815b9d-eb0c-4b61-8773-69665a3afedf` (`matulamichele+resendsmoke@gmail.com`) + email_verifications + utenza Cognito pool clienti | DELETE (DB + Cognito) |
| 6 | Smoke invito utente (2026-06-12) | Riga `invitations` per `matulamichele+invitesmoke@gmail.com` (mai accettata) + riga `audit_logs` collegata | DELETE |
| 7 | Smoke email revised/cancelled/created (2026-06-11/12) | 2 interventi smoke su GG123ZZ `1535dd8b-0433-4ef1-ba9c-30d1b4f901a8`: quello dell'11/06 ~13:09 (poi modificato e annullato) + quello del 12/06 (smoke #200), con relative `intervention_revisions` | DELETE (vedi sezione 7) |
| 8 | Smoke push e2e + tap deep-link (2026-06-11/12) | ~7 `intervention_revisions` di test (reason fittizie) sull'intervento `a2a66c05-e69b-4fea-95de-e74a6d8c9b3d` — l'intervento in sé è dato demo legittimo e RESTA | DELETE solo revisioni di test |

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

## Sezione 5 — Customer smoke Resend (DB + Cognito)

```sql
-- Verifica: 1 customer, 0 veicoli/ownership, eventuali email_verifications/push_tokens
SELECT id, email, status, cognito_sub FROM customers WHERE id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';
SELECT count(*) FROM vehicle_ownerships WHERE customer_id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';

BEGIN;
-- email_verifications e push_tokens hanno FK ON DELETE CASCADE dal customer,
-- ma i DELETE espliciti rendono l'esito visibile.
DELETE FROM email_verifications WHERE customer_id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';
DELETE FROM push_tokens          WHERE customer_id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';
DELETE FROM customer_tenant_relations WHERE customer_id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';
DELETE FROM customers WHERE id = '2d815b9d-eb0c-4b61-8773-69665a3afedf';
COMMIT;
```

Poi l'utenza Cognito (pool clienti `eu-central-1_vBdWRi9Kj`, CLI locale con
credenziali operatore — il sub esatto è nella colonna `cognito_sub` della
SELECT sopra, ma admin-delete-user accetta lo username/email alias):

```bash
aws cognito-idp admin-delete-user --region eu-central-1 \
  --user-pool-id eu-central-1_vBdWRi9Kj \
  --username matulamichele+resendsmoke@gmail.com
```

## Sezione 6 — Invito utente smoke

```sql
-- Verifica: 1 riga, accepted_at NULL
SELECT id, invitation_type, target_email, accepted_at, expires_at
FROM invitations WHERE target_email = 'matulamichele+invitesmoke@gmail.com';

BEGIN;
DELETE FROM audit_logs WHERE entity_type = 'invitation'
  AND entity_id IN (SELECT id FROM invitations WHERE target_email = 'matulamichele+invitesmoke@gmail.com');
DELETE FROM invitations WHERE target_email = 'matulamichele+invitesmoke@gmail.com';
COMMIT;
```

Nota: l'invito non è mai stato accettato → nessun utente Cognito creato nel
pool officine, nessuna riga `users`.

## Sezione 7 — Interventi smoke su GG123ZZ

Identificare prima i 2 interventi (NON toccare gli altri interventi del
veicolo, che sono dati demo):

```sql
-- Attesi 2: uno dell'11/06 (status cancelled, con revisions) e uno del 12/06 (active)
SELECT id, status, title, created_at, cancelled_at
FROM interventions
WHERE vehicle_id = '1535dd8b-0433-4ef1-ba9c-30d1b4f901a8'
  AND created_at >= '2026-06-11'
ORDER BY created_at;

-- Figli attesi: solo intervention_revisions sull'intervento dell'11/06.
SELECT 'revisions' t, count(*) FROM intervention_revisions WHERE intervention_id IN ('<id_11_06>','<id_12_06>')
UNION ALL SELECT 'attachments', count(*) FROM attachments WHERE intervention_id IN ('<id_11_06>','<id_12_06>')
UNION ALL SELECT 'disputes', count(*) FROM intervention_disputes WHERE intervention_id IN ('<id_11_06>','<id_12_06>')
UNION ALL SELECT 'deadlines', count(*) FROM deadlines WHERE source_intervention_id IN ('<id_11_06>','<id_12_06>');

BEGIN;
DELETE FROM intervention_revisions WHERE intervention_id IN ('<id_11_06>','<id_12_06>');
DELETE FROM deadlines WHERE source_intervention_id IN ('<id_11_06>','<id_12_06>');
DELETE FROM interventions WHERE id IN ('<id_11_06>','<id_12_06>');
COMMIT;
```

Nota: il DELETE fisico contraddice BR-066 a livello applicativo, ma qui è
igiene del DB demo da superuser (gli interventi sono interamente artefatti
di smoke). Gli `access_logs` create/update su GG123ZZ restano: sono storia
BR-154 mischiata a quella legittima del veicolo e non disturbano.

## Sezione 8 — Revisioni di test su `a2a66c05` (l'intervento RESTA)

```sql
-- Verifica: ~7 righe con reason di test (smoke push/tap 2026-06-11/12)
SELECT id, revised_at, reason FROM intervention_revisions
WHERE intervention_id = 'a2a66c05-e69b-4fea-95de-e74a6d8c9b3d'
ORDER BY revised_at;

-- Se TUTTE le righe sono di smoke (reason fittizie), pulizia integrale:
DELETE FROM intervention_revisions
WHERE intervention_id = 'a2a66c05-e69b-4fea-95de-e74a6d8c9b3d';
-- Altrimenti DELETE ... WHERE id IN ('<solo le righe di test>');
```

Nota: cancellare le revisions NON ripristina i campi dell'intervento — se i
valori correnti (description/km) sono rimasti "sporchi" dall'ultimo smoke,
sistemarli dalla web app PRIMA di cancellare le revisions (l'edit genererà
un'ultima revision da includere nel DELETE).

## Post-esecuzione

- Annotare qui data di esecuzione ed esito delle SELECT di verifica.
- Aggiornare il checkpoint di memoria (pulizia DB prod non più pending).
