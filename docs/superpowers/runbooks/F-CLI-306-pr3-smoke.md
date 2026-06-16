# Smoke runbook — F-CLI-306 PR3 Scadenze personali mobile (BLOCKER)

**Stato: DA ESEGUIRE**

Verifica su device del flusso completo "Scadenze personali" lato app mobile:
creazione, modifica, notifiche push+email, routing da tap, rinnovo guidato
(BR-296), eliminazione e cancellazione su trasferimento (BR-297).

> **BLOCKER:** il codice PR3 è nel bundle JS dell'APK — serve una **nuova
> build EAS preview** post-merge. Non è possibile validare con Metro/Expo Go
> perché il bundle precedente non contiene questi schermi.

## Prerequisiti

1. **Nuova build EAS preview** (da eseguire dopo il merge di PR3 su `main`):
   ```
   cd packages/mobile
   npx eas-cli@latest build --profile preview --platform android
   ```
   Gotcha monorepo (da `feedback_eas_build_monorepo_gotchas`):
   - pin `node`/`pnpm` in `eas.json` (profilo `base` + `extends`) — già configurato da #194;
   - `shamefully-hoist=true` nel root `.npmrc` — già a posto da #194;
   - NON aggiungere `node-linker=hoisted` (rompe i test web, doppio react).

2. **Install APK** dal link della build page EAS direttamente sul device
   (no Metro, no adb obbligatorio). Il device non ha bisogno di account Expo.

3. **Account di test** con almeno un veicolo **posseduto** (owner attivo,
   stato `certified`):
   - Account principale: `matulamichele+b2cpwd@gmail.com` ("Pippo Baudo",
     customer `731b3cb3`) — possiede il veicolo `GO-346-AJJE`.
   - Per lo step h (cancel-on-transfer, BR-297) serve un secondo account
     che accetti il trasferimento: `matulamichele+cliente1@gmail.com`.

4. **Token push attivo**: Profilo → Notifiche → toggle push device ON
   (all'avvio dell'APK nuovo il token viene rinegoziato automaticamente;
   verificare la riga in `push_tokens` via Supabase SQL editor:
   `SELECT * FROM push_tokens WHERE customer_id = '731b3cb3' ORDER BY created_at DESC LIMIT 1;`).

5. **Preferenza globale** `personal_deadline_reminder` **abilitata**
   (default ON; verificare in Profilo → Notifiche se compare il toggle).

## Step

### A. Navigazione al segmento Personali

| # | Azione | Atteso | Esito |
|---|---|---|---|
| a1 | Tab Scadenze | Due segmenti: "Officina" e "Personali"; default su "Officina" | |
| a2 | Tap "Personali" | Segmento Personali aperto; lista vuota con CTA "Aggiungi scadenza" (se nessuna scadenza) | |

### B. Creazione scadenza — categoria standard

| # | Azione | Atteso | Esito |
|---|---|---|---|
| b1 | Tap "Aggiungi scadenza" (o "+ " nella header) | Form "Nuova scadenza" aperto | |
| b2 | Selezionare veicolo `GO-346-AJJE` dal picker | Veicolo selezionato | |
| b3 | Categoria: "Assicurazione" (o altra categoria standard) | Campo selezionato, nessun campo "Etichetta personalizzata" visibile | |
| b4 | Data scadenza: tra 35 e 40 giorni da oggi (es. 2026-07-26) | Data accettata | |
| b5 | Reminder: lasciare default [30, 7, 0] giorni prima | Chip selezionati | |
| b6 | Notifiche push e email: ON | Toggle ON | |
| b7 | Submit | Scadenza creata; redirect al dettaglio o alla lista; la nuova scadenza compare nel gruppo urgency corretto (con data a 35-40 gg: "Questo mese" o "Oltre") | |

### C. Creazione scadenza — categoria `other` con etichetta personalizzata

| # | Azione | Atteso | Esito |
|---|---|---|---|
| c1 | Aggiungi seconda scadenza sullo stesso veicolo | Form aperto | |
| c2 | Categoria: "Altro" | Campo "Etichetta personalizzata" appare (BR-294) | |
| c3 | Lasciare etichetta vuota → Submit | Errore IT "Inserisci un'etichetta per la categoria personalizzata." (BR-294) | |
| c4 | Compilare etichetta es. "Controllo pneumatici" | Campo accettato | |
| c5 | Data: domani o dopodomani (scadenza urgente per test gruppo "Scadute"/"Questa settimana") | Data accettata | |
| c6 | Submit | Scadenza "other" creata; compare nel gruppo corretto (es. "Scadute" se ieri, "Questa settimana" se entro 7 giorni) | |

### D. Verifica lista e raggruppamento urgency

| # | Azione | Atteso | Esito |
|---|---|---|---|
| d1 | Segmento Personali | Almeno due scadenze, divise nei gruppi corretti: quella con data prossima in "Scadute" o "Questa settimana"; quella con data lontana in "Questo mese" o "Oltre" | |
| d2 | La scadenza "Altro" mostra l'etichetta personalizzata (non "Altro") | Label "Controllo pneumatici" visibile in lista | |

### E. Modifica scadenza

| # | Azione | Atteso | Esito |
|---|---|---|---|
| e1 | Tap sulla scadenza "Assicurazione" → detail | Schermata dettaglio aperta con tutti i campi | |
| e2 | Tap "Modifica" | Form aperto in modalità edit; il picker veicolo è di sola lettura in modifica (l'API non prevede riassegnazione del veicolo) | |
| e3 | Cambiare data scadenza (es. spostare di un mese) e disabilitare il reminder a 30 giorni | Modifiche locali nel form | |
| e4 | Salva | Modifica persistita; la scadenza si sposta nel gruppo urgency corretto nella lista | |
| e5 | Riaprire il dettaglio | I valori aggiornati sono presenti | |

### F. Notifiche — delivery push e email

L'obiettivo è verificare che la catena `sweep → dispatch → device` funzioni
senza aspettare il cron delle 06:00 UTC. Due approcci alternativi:

**Approccio F1 — trigger SQL (consigliato per smoke rapido):**

```sql
-- Supabase SQL editor (service role / superuser)
-- Trovare un reminder pending della scadenza creata nello step B
SELECT id, personal_deadline_id, scheduled_for, delivery_status
  FROM personal_deadline_reminders
 WHERE personal_deadline_id IN (
         SELECT id FROM personal_deadlines WHERE customer_id = '731b3cb3'
       )
   AND delivery_status = 'pending'
 ORDER BY scheduled_for
 LIMIT 5;

-- Anticipare scheduled_for a ieri per farlo rilevare dallo sweep
UPDATE personal_deadline_reminders
   SET scheduled_for = CURRENT_DATE - INTERVAL '1 day'
 WHERE id = '<id del reminder>';
```

Poi invocare il Lambda sweep manualmente dalla console AWS
(Lambda → `garageos-personal-deadline-sweep` → Test con payload `{}`).

**Approccio F2 — Expo push tool (per validare solo delivery+routing):**

Recuperare il token push da `push_tokens`:
```sql
SELECT expo_push_token FROM push_tokens
 WHERE customer_id = '731b3cb3' AND active = true
 ORDER BY created_at DESC LIMIT 1;
```
Usare https://expo.dev/notifications con payload:
```json
{
  "to": "ExponentPushToken[...]",
  "title": "Scadenza personale",
  "body": "Assicurazione — tra 30 giorni",
  "data": {
    "type": "personal_deadline.reminder",
    "personalDeadlineId": "<id della scadenza>"
  }
}
```
Verificare delivery (tap dal device) e routing (step G).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| f1 | Lambda sweep eseguito (approccio F1) OPPURE push tool (approccio F2) | Push ricevuta sul device | |
| f2 | Email ricevuta (solo approccio F1 — la sweep invia entrambi i canali se BR-292 AND soddisfatto) | Email "Promemoria scadenza personale" nella inbox | |
| f3 | Toggle pref `personal_deadline_reminder` OFF → ripetere sweep | Nessuna push/email (BR-292: preferenza globale OFF blocca entrambi i canali) | |
| f4 | Riattivare la pref | Toggle ON | |

> ⚠️ BR-292 channel-AND: sia `notify_push` della singola scadenza SIA la
> preferenza globale `personal_deadline_reminder` devono essere ON. Se una
> delle due è OFF, nessuna notifica viene inviata (non solo il canale).

### G. Routing da tap — deep link alla detail screen

| # | Azione | Atteso | Esito |
|---|---|---|---|
| g1 | App in BACKGROUND, tap sulla push notifica | App in foreground apre `/my-deadlines/<id>` — detail della scadenza corretta | |
| g2 | App in stato KILLED (uccidere dal task manager), tap sulla push | Cold start → dopo splash/auth loading, apre la detail screen (fallback Android `trigger.remoteMessage.data.body` validato) | |
| g3 | App in FOREGROUND | Banner di sistema visibile; tap → naviga alla detail | |

### H. Rinnovo guidato — BR-296 (scadenza ricorrente)

Per questo step creare prima una scadenza ricorrente:

```sql
-- Verificare o creare una scadenza con recurrence_months != NULL
-- Se la scadenza B ha recurrence_months=12 (impostato nel form), OK.
-- In alternativa: PATCH via SQL
UPDATE personal_deadlines
   SET recurrence_months = 12
 WHERE id = '<id scadenza assicurazione>';
```

| # | Azione | Atteso | Esito |
|---|---|---|---|
| h1 | Detail scadenza ricorrente → tap "Segna come fatta" | Dialog di conferma | |
| h2 | Conferma | App naviga al form "Nuova scadenza" **pre-compilato** con: `suggestedDueDate` = dueDate + 12 mesi, stessa categoria, stessi reminder/canali (BR-296) | |
| h3 | Modificare la data suggerita se necessario → Submit | Nuova scadenza creata; la precedente è `completed` e sparisce dalla lista "open" | |
| h4 | Scadenza NON ricorrente → "Segna come fatta" | Nessun form pre-compilato: torna direttamente alla lista (BR-296 non si applica) | |

### I. Eliminazione scadenza

| # | Azione | Atteso | Esito |
|---|---|---|---|
| i1 | Detail scadenza → tap "Elimina" (o icona cestino) | Dialog di conferma IT "Eliminare questa scadenza?" | |
| i2 | Conferma eliminazione | Redirect alla lista; la scadenza è sparita (hard delete — i reminder cascade vengono rimossi) | |

### J. Cancel-on-transfer — BR-297

> Richiede F-CLI-401 attivo (già shipped). Serve un secondo account.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| j1 | Verificare che la scadenza "Controllo pneumatici" (step C, stato `open` o `overdue`) sia visibile nella lista Personali dell'account Pippo Baudo | Presente | |
| j2 | Account Pippo Baudo: avviare trasferimento veicolo `GO-346-AJJE` all'account `matulamichele+cliente1@gmail.com` (F-CLI-401 flow) e completarlo | Trasferimento `completed` | |
| j3 | SQL editor — verificare cancellazione automatica: `SELECT id, status FROM personal_deadlines WHERE customer_id = '731b3cb3' AND vehicle_id = '<id veicolo>' AND status = 'open';` | Zero righe (BR-297: sweep o trigger ha cancellato le scadenze open/overdue del vecchio proprietario) | |
| j4 | App Pippo Baudo → segmento Personali | La scadenza "Controllo pneumatici" è sparita dalla lista | |

> ⚠️ BR-297 è eseguito dal cron sweep giornaliero (non da un trigger
> sincrono sul transfer). Per vederlo immediatamente: invocare il Lambda
> `garageos-personal-deadline-sweep` manualmente dopo il completamento del
> trasferimento.

## Stato prod post-smoke

Annotare qui i dati di test lasciati in prod da pulire:

- Scadenze personali create durante lo smoke (IDs): ___
- Reminder aggiornati via SQL per forzare la sweep (IDs): ___
- Trasferimento J usato (riportare il veicolo a Pippo Baudo se necessario): ___
- Pulizia: `DELETE FROM personal_deadlines WHERE id IN (...);` (cascade rimuove i reminder)

## Esiti

_(Da compilare dopo l'esecuzione)_
