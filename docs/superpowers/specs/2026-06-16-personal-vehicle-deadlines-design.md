# F-CLI-306 — Scadenze personali del cliente (self-service) — Design

- **Data:** 2026-06-16
- **Feature:** F-CLI-306 (NUOVO codice — `Notifiche push nuovi interventi` occupava già F-CLI-303; 301–305 tutti assegnati)
- **Area spec:** §3.3.4 "Area Scadenze e Notifiche" (app cliente)
- **Stato spec master:** §157 differiva esplicitamente a v2 le "scadenze auto-configurate dal sistema (revisione, bollo)". Questa spec realizza quel v2 nella forma *self-service del cliente*.
- **BR nuove:** BR-290 … BR-298 (blocco verificato libero il 2026-06-16; il plan ripete il pre-flight grep prima di fissarle)

---

## 1. Problema e obiettivo

Pain point §48 / persona §207: il cliente finale non ha un sistema strutturato che gli ricordi le scadenze del proprio veicolo (assicurazione, bollo, revisione, tagliando, cinghia…). Oggi GarageOS ha solo lo **scadenzario lato officina** (modello `Deadline`, feature H3/F-OFF-401): scadenze configurate dal tenant, legate a un `interventionType`, con reminder fissi t-30/t-7/t-0 schedulati via EventBridge one-shot.

Obiettivo: dare al cliente, nell'app mobile, la possibilità di **creare e gestire scadenze personali** sui veicoli che possiede, con **tempistiche di notifica configurabili** su **push ed email**, indipendenti dall'officina e **private** (l'officina non le vede).

Non-obiettivi (YAGNI): OCR libretto, import automatico scadenze da fonti esterne, SMS (v1.1), centro notifiche in-app (F-CLI-305, separato), scadenze su veicoli non posseduti.

## 2. Perché tabelle nuove e non il `Deadline` esistente

Il `Deadline` officina è tenant-coupled: `tenantId`, `locationId`, `interventionTypeId` NON NULL, scoping RLS per tenant, reminder type fissi (`t_minus_30|t_minus_7|t_zero|km_reached`). Il modello di proprietà e sicurezza qui è opposto (customer-owned, scoping per `customerId`) e la configurazione reminder è libera. Forzare il riuso significherebbe rendere nullable mezza tabella e biforcare ogni query/policy. → **Due tabelle nuove, customer-owned.**

## 3. Modello dati

### 3.1 `PersonalDeadline`

| Campo | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `customerId` | uuid FK→Customer, cascade | proprietario; chiave di scoping |
| `vehicleId` | uuid FK→Vehicle, cascade | veicolo posseduto al momento della creazione |
| `category` | enum `PersonalDeadlineCategory` | `insurance \| road_tax \| inspection \| service \| tires \| timing_belt \| other` |
| `customLabel` | text? | obbligatoria sse `category = other`; max 80 char (BR-294) |
| `dueDate` | date | scadenza (componente orario ignorato) |
| `recurrenceMonths` | smallint? | periodicità *indicativa* per rinnovo guidato; null = non ricorrente; range 1–120 |
| `reminderLeadDays` | int[] | anticipi singoli scelti (es. `[30,7,0]`); `0` = giorno stesso; valori 0–365 |
| `reminderDailyTailDays` | smallint? | coda giornaliera: una notifica/giorno negli ultimi N giorni; null/0 = off; cap 30 (BR-293) |
| `notifyPush` | bool | canale per-scadenza |
| `notifyEmail` | bool | canale per-scadenza |
| `status` | enum `PersonalDeadlineStatus` | `open \| completed \| overdue \| cancelled` |
| `notes` | text? | max 500 char |
| `completedAt` | timestamptz? | |
| `createdAt` / `updatedAt` | timestamptz | |

Indici: `(customerId, status, dueDate)` per la lista per urgenza; `(vehicleId)` per la cancellazione su transfer.

### 3.2 `PersonalDeadlineReminder` (reminder materializzati)

| Campo | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `personalDeadlineId` | uuid FK→PersonalDeadline, cascade | |
| `scheduledFor` | date | giorno in cui parte la notifica (08:00 Europe/Rome) |
| `kind` | enum `PersonalDeadlineReminderKind` | `lead \| tail` — solo per il wording del template |
| `deliveryStatus` | enum (riuso `NotificationDeliveryStatus`) | `pending \| sent \| failed \| cancelled` |
| `sentAt` | timestamptz? | |
| `failureReason` | text? | |
| `createdAt` | timestamptz | |

Indici: `(personalDeadlineId)`; `(scheduledFor, deliveryStatus)` per lo sweep.

**Niente EventBridge per-riga**: i reminder sono righe scansionate da un cron giornaliero (§5).

### 3.3 Generazione reminder (lib `personal-deadlines/build-reminders.ts`)

Input: `dueDate`, `reminderLeadDays`, `reminderDailyTailDays`, `now`.
1. Insieme di giorni = `{ dueDate − d : d ∈ leadDays }` ∪ `{ dueDate − k : k ∈ [0 .. tail−1] }`.
2. Deduplica per data calendario (un `lead=7` e il `tail` che copre il giorno -7 collassano in una riga; `kind=lead` vince per il wording).
3. Ancoraggio 08:00 Europe/Rome, DST-aware — **riuso `compute-reminders.ts`** (`romeLocalToUtc`, skew buffer BR-103): scarta i giorni già passati (≤ now+skew).
4. Per ogni giorno rimasto → una `PersonalDeadlineReminder` `pending`.

Cap: `leadDays` max 10 valori; `tail` max 30 → ≤ ~40 righe/scadenza (BR-293).

## 4. Notifiche e preferenze

- Nuovo membro union `NotificationEvent`: `{ type: 'personal_deadline.reminder', … }` con i dati di template (categoria/label, dueDate ISO, vehiclePlate, vehicleMakeModel, kind, daysUntilDue).
- Nuovo template **email** (`templates/personal-deadline-reminder.ts`) + **push** (`push-templates.ts`). Italiano, via i18n/stringhe esistenti.
- Nuova chiave preferenza globale **`personal_deadline_reminder`** aggiunta a `DEFAULT_NOTIFICATION_PREFERENCES` (`email` + `push`, default `true`), a `EDITABLE_EMAIL_KEYS`, `EDITABLE_PUSH_KEYS`, `NotificationEventPrefKey`, `EmailEnabledKey` → compare automaticamente nella schermata F-CLI-005 e in `event-preference-key`.
- **Gating canali (BR-292):** canale effettivo = `notify{Push,Email}` della scadenza **AND** preferenza globale del cliente. Il globale è il master-kill. Lo sweep handler calcola i canali effettivi e li passa al dispatch (vedi §5); se entrambi i canali risultano off, il reminder è marcato `cancelled` "channels_off".

## 5. Scheduling — cron giornaliero (Approccio A)

### 5.1 Infra (CDK)
- Nuovo `CfnSchedule` singleton **`PersonalDeadlineSweepSchedule`** in `infrastructure/lib/constructs/scheduler.ts`, mirror di `TransferExpirySchedule`/`WarmingSchedule`: `cron(0 6 * * ? *)` UTC (≈ 08:00 Rome, accettando il drift DST di 1h come il resto del sistema), gruppo `default`, riusa `SchedulerRole` e il flag `warmingEnabled`, nome costante. **Zero nuova IAM/config/prop.**
- Payload target top-level `{ source: 'personal-deadline-sweep' }`.
- ⚠️ **Cascade test infra:** il nuovo `CfnSchedule` rompe `resourceCountIs('AWS::Scheduler::Schedule', N)` in `infrastructure/tests/main-stack.test.ts` (CI-only, invisibile a typecheck — lezione #182). Il plan PR2 deve: bump del count + `hasResourceProperties` per il nuovo schedule.

### 5.2 Guard
- Nuovo `withPersonalDeadlineSweepGuard` (`lambda-personal-deadline-sweep.ts`, mirror `withTransferExpiryGuard`): match top-level `source === 'personal-deadline-sweep'`, disgiunto da `warming`/`transfer-expiry`/`aws.scheduler`. Wired in `index.ts` nella catena guard.

### 5.3 Handler sweep (`personal-deadlines/sweep.ts`)
Sotto `withContext({ role: 'admin' })` (le invocazioni scheduler non portano JWT — lezione `withcontext_empty_blocks_rls_writes`):
1. `findMany` reminder con `scheduledFor <= today(Rome)` AND `deliveryStatus = 'pending'` AND `deadline.status = 'open'`. (Reminder con `scheduledFor` più vecchio di una soglia, es. 3 giorni → marcati `cancelled` "stale", non inviati.)
2. Per ogni reminder: risolve il cliente proprietario della scadenza (`PersonalDeadline.customer`); calcola i canali effettivi (BR-292); `dispatchNotification({ type: 'personal_deadline.reminder', … })` — `dispatchNotification` NON lancia mai.
3. Marca la riga `sent`/`failed`/`cancelled` secondo l'esito (mirror della macchina a stati di `scheduler-invocation.ts`). Idempotente: gate su `pending`, retry sicuri.

**Recupero giorni saltati:** se il cron salta un giorno, `scheduledFor <= today` recupera i reminder arretrati (entro la soglia stale). Granularità giornaliera a ora fissa: esattamente il bisogno.

## 6. API (customer, `/v1/me`, `role:'user'`)

Sicurezza **app-layer**: RLS `USING(true)` sulle due tabelle + filtro `customerId` in OGNI query (mai RLS sola — lezione #154). Nessuna PII di terzi nei DTO. **Le tabelle non sono mai esposte da endpoint/DTO officina** (privacy BR-291, stile BR-081).

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/v1/me/personal-deadlines` | crea. Valida che il cliente **possieda ora** il `vehicleId` (BR-290, ownership corrente). Genera i reminder (§3.3). |
| GET | `/v1/me/personal-deadlines` | lista propria, ordinata per urgenza (`dueDate` asc, `open`/`overdue` prima); filtri `?status=`, `?vehicleId=`. |
| GET | `/v1/me/personal-deadlines/:id` | dettaglio (404 se non del cliente). |
| PATCH | `/v1/me/personal-deadlines/:id` | modifica `dueDate`/reminder/canali/categoria/note/ricorrenza → **rigenera** i reminder `pending` (cancella i pending, ne crea di nuovi; i `sent` restano, append-only). |
| DELETE | `/v1/me/personal-deadlines/:id` | elimina (cascade sui reminder). |
| POST | `/v1/me/personal-deadlines/:id/complete` | segna `completed` (`completedAt=now`), cancella i reminder `pending`. Se `recurrenceMonths` valorizzato, la risposta include un blocco `renewalSuggestion` con i dati precompilati della prossima scadenza (data proposta = `dueDate + recurrenceMonths`, stessa config). |

**Rinnovo guidato (BR-296):** nessun endpoint `renew` dedicato. Il client, ricevuto `renewalSuggestion`, riapre il form di creazione precompilato; l'utente **conferma o corregge la data reale** e fa un normale POST. Zero creazione automatica con data potenzialmente errata.

**Cancellazione su transfer (BR-297):** quando un veicolo cambia proprietario (passaggio cliente F-CLI-401 *o* officina-mediato F-OFF-110), tutte le `PersonalDeadline` `open`/`overdue` del **vecchio** proprietario su quel veicolo passano a `cancelled` e i loro reminder `pending` a `cancelled`. Hook nel punto di swap proprietà (`transfer-swap.ts` / `ownership-transfer.ts`).

**Error code:** famiglia nuova `personal_deadline.*` da registrare in APPENDICE_G (il plan fa pre-flight grep — la famiglia potrebbe non esistere ancora): `personal_deadline.vehicle_not_owned` (403), `personal_deadline.not_found` (404), `personal_deadline.custom_label_required` (422), `personal_deadline.invalid_reminder_config` (422), `personal_deadline.not_open` (409, su complete/renew di scadenza non aperta).

## 7. Mobile — tab "Le mie scadenze"

- Nuova tab in `app/(tabs)` (es. `my-deadlines.tsx` + voce nel `_layout`): lista per urgenza, raggruppata (Scadute / Questa settimana / Questo mese / Oltre), badge+icona per categoria.
- **Form crea/modifica** (`app/my-deadlines/new.tsx`, `[id].tsx`): picker veicolo (solo posseduti, da `me/vehicles`) · chip categoria + campo label se `other` · date picker · config reminder (checkbox anticipi {60/30/15/7/3/1/0 g} + toggle "poi ogni giorno negli ultimi N giorni" con stepper N) · toggle canali Push/Email · ricorrenza opzionale (mesi). Default precompilato: `lead [30,7,0]`, tail off, push+email on, ricorrenza off.
- **Dettaglio**: riepilogo config + "Segna come fatta" → se ricorrente, apre il form precompilato (rinnovo guidato).
- `src/queries/personalDeadlines.ts` (hook CRUD + invalidazioni), mapping error IT in `error-messages.ts`.
- Tier 2 test (2–3/schermata): happy path lista, stato errore, logica condizionale (label `other`, tail toggle).

## 8. Business rules (proposte; il plan fissa i numeri dopo grep)

- **BR-290** — Una `PersonalDeadline` può essere creata solo su un veicolo posseduto dal cliente al momento della creazione (ownership corrente, BR-040).
- **BR-291** — Le scadenze personali sono private del cliente: mai esposte ad alcun endpoint/DTO officina (stile BR-081).
- **BR-292** — Canale di notifica effettivo = flag per-scadenza AND preferenza globale `personal_deadline_reminder`.
- **BR-293** — Cap reminder: ≤10 anticipi, coda ≤30 giorni, ≤~40 reminder materializzati per scadenza.
- **BR-294** — `customLabel` obbligatoria e non vuota sse `category = other`; ignorata altrimenti.
- **BR-295** — Reminder ancorati alle 08:00 Europe/Rome, DST-aware, con skew buffer (riuso BR-103); giorni passati scartati.
- **BR-296** — Rinnovo guidato: niente auto-creazione; la prossima scadenza nasce solo da conferma esplicita del cliente con data reale.
- **BR-297** — Al cambio proprietà del veicolo, le scadenze personali `open`/`overdue` del precedente proprietario su quel veicolo passano a `cancelled` (reminder pending → cancelled).
- **BR-298** — Transizione `open → overdue`: lo sweep giornaliero porta a `overdue` ogni scadenza `open` con `dueDate < today(Rome)`. Stato persistito (non derivato in lettura), così la lista e i filtri restano coerenti senza calcolo a runtime. Le scadenze `overdue` restano visibili finché il cliente non le completa o elimina.

## 9. Decomposizione (arco multi-PR, subagent-driven)

- **PR1 — DB + API CRUD.** Migration (2 tabelle + 3 enum), validators, lib `build-reminders`, route `me-personal-deadlines.ts` (CRUD + complete), DTO. Niente dispatch/cron ancora. Test Tier 1 (scoping, ownership negativi, build-reminders incl. DST/skew, state machine, contratti/error code).
- **PR2 — Notifiche e2e + cron.** Nuovo evento + template email/push + chiave preferenza (superficie F-CLI-005) + `CfnSchedule` + guard + sweep handler + hook cancellazione-su-transfer (BR-297). Test Tier 1 (gating canali, idempotenza sweep, stale, transfer-cancel) + fix cascade `resourceCountIs`.
- **PR3 — Mobile.** Tab, form crea/modifica, dettaglio, rinnovo guidato, queries, error map. Test Tier 2 + **smoke device** (BLOCKER: nuova build EAS — push reali).

## 10. Testing

- **Tier 1 (full):** ownership scoping (negativi: crea su veicolo non posseduto → 403; lettura scadenza altrui → 404); calcolo reminder (lead+tail, dedup, DST, skew, cap); idempotenza e branch sweep; gating canali (per-scadenza × globale, matrice); state machine `open/completed/overdue/cancelled`; cancellazione-su-transfer; contratti API + error code RFC7807; privacy (nessun leak officina).
- **Tier 2 (mobile):** 2–3 test per schermata, no pure-rendering.
- **Smoke (PR3, BLOCKER):** creazione scadenza, ricezione push+email reali a T-anticipo/coda, rinnovo guidato, cancellazione su transfer.

## 11. Rischi e mitigazioni

- **Esplosione righe reminder** → cap BR-293; il cron scala (un solo schedule).
- **Cron salta un giorno** → recupero via `scheduledFor <= today` con soglia stale.
- **Drift DST sull'ora cron** → accettato (come warming/transfer-expiry); il reminder resta nel giorno giusto.
- **Doppia fonte canali (per-scadenza vs globale)** → BR-292 definisce l'AND in modo non ambiguo; un solo punto di calcolo (sweep handler).
- **Cascade test infra** → annotato in §5.1, gestito nel plan PR2.
