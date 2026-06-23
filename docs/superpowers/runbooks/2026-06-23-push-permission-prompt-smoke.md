# Smoke runbook — push-permission prompt (soft-ask modal + reminder banner) — BLOCKER

**Stato: DA ESEGUIRE**

Verifica su device del flusso completo di richiesta permesso notifiche:
modale di priming "soft-ask" (una volta sola, dopo il primo login) e banner
contestuale di promemoria (tab Scadenze + detail intervento officina).
Copre sia il path `denied` (il sistema OS mostrerà ancora il prompt) sia il
path `blocked` (serve aprire le Impostazioni di sistema).

> **BLOCKER:** questo smoke deve essere eseguito su una **dev build** —
> `expo-notifications` richiede le API native presenti solo nelle build
> native (dev client o preview APK). **Expo Go non funziona.** Non è
> possibile validare il comportamento dei permessi su Expo Go.

---

## Prerequisiti

1. **Dev build installata sul device.** Se è disponibile l'APK dalla build
   dev client corrente, installarla via `adb install` oppure via link dalla
   build page EAS. In alternativa, avviare una build dev client locale:
   ```
   cd packages/mobile
   npx expo run:android
   ```
   oppure usare un profilo EAS `development`. Il device deve essere Android
   (il runbook si concentra su Android; iOS è differito).

2. **Metro attivo e `adb reverse` asserito:**
   ```
   npx expo start --offline    # dalla root packages/mobile oppure dalla root repo con il filter
   adb reverse tcp:8081 tcp:8081
   ```
   > Se il device non riflette le modifiche, re-asserire `adb reverse tcp:8081`
   > **prima** di sospettare il codice (vedi `feedback_adb_reverse_drops_stale_bundle`).

3. **Account di test:** un account abilitato all'accesso (`matulamichele@gmail.com`
   è l'unico account usabile nel setup attuale — o altro account di test
   configurato). L'account deve avere almeno un veicolo con un intervento
   officina visibile (per il Caso 4, step su detail intervento).

4. **Stato notifiche OS** gestito caso per caso (vedere sotto). Per il **Caso 1**
   è richiesto un device in stato "notifiche non ancora concesse" — tipicamente
   un'installazione fresca o dopo **clear app data**:

   > Android: Impostazioni del dispositivo → App → GarageOS → Archiviazione →
   > **Cancella dati** (oppure disinstallare e reinstallare la dev build).
   > Questo azzera anche il flag `softAskSeen` in AsyncStorage. Senza questo
   > passaggio il modale non riapparirà se era già stato visto.

5. **Permesso OS resettato prima di ogni caso** che richiede lo stato `denied`
   (OS prompt ancora disponibile): su Android il sistema concede una sola
   "seconda chance" dopo il primo rifiuto; se il prompt è già stato rifiutato
   due volte lo stato diventa `blocked`. Verificare lo stato in
   Impostazioni → App → GarageOS → Notifiche prima di ogni caso.

---

## Caso 1 — Fresh install / primo login: modale soft-ask appare

**Precondizioni:** app data cancellata (AsyncStorage vuoto, `softAskSeen` non
impostato); notifiche OS non ancora concesse (stato `denied` — il sistema può
ancora mostrare il prompt); account di test pronto.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 1.1 | Aprire la dev build, eseguire il login con l'account di test | Login completato; app naviga alla tab Veicoli | ☐ PASS / ☐ FAIL |
| 1.2 | Attendere 1-2 secondi sulla tab Veicoli | Il modale **"Attiva le notifiche"** appare sopra il contenuto | ☐ PASS / ☐ FAIL |
| 1.3 | Verificare il testo del modale | Titolo: "Attiva le notifiche"; corpo: "Ti avvisiamo quando ci sono aggiornamenti sui tuoi interventi e promemoria per le scadenze dei tuoi veicoli."; due pulsanti: **"Attiva notifiche"** e **"Non ora"** | ☐ PASS / ☐ FAIL |

---

## Caso 2 — "Attiva notifiche" → prompt OS → concessione → modale e banner scompaiono

**Precondizioni:** partire dal Caso 1 con il modale visibile (o ripristinare lo
stato: clear app data + notifiche OS non concesse + login).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 2.1 | Tap sul pulsante **"Attiva notifiche"** | Il prompt di sistema Android "Consenti a GarageOS di inviare notifiche?" appare | ☐ PASS / ☐ FAIL |
| 2.2 | Tap **"Consenti"** nel prompt OS | Il modale scompare; nessun banner visibile nella tab Veicoli | ☐ PASS / ☐ FAIL |
| 2.3 | Navigare alla tab **Scadenze** | Nessun banner di promemoria notifiche visibile | ☐ PASS / ☐ FAIL |
| 2.4 | Aprire il detail di un intervento officina (tab Veicoli → veicolo → intervento) | Nessun banner di promemoria notifiche visibile | ☐ PASS / ☐ FAIL |
| 2.5 | Profilo → **Notifiche** → toggle "Notifiche push dispositivo" | Il toggle è **ON**; nessun hint "Apri impostazioni" visibile | ☐ PASS / ☐ FAIL |

---

## Caso 3 — "Non ora": nessun prompt OS, modale non riappare al riavvio

**Precondizioni:** clear app data + notifiche OS non concesse (stato `denied`) +
login (modale visibile, come Caso 1).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 3.1 | Tap **"Non ora"** sul modale | Il modale scompare; nessun prompt OS appare | ☐ PASS / ☐ FAIL |
| 3.2 | Navigare tra le tab (Scadenze, Profilo, Veicoli) | Nessun modale, nessun prompt OS | ☐ PASS / ☐ FAIL |
| 3.3 | Uccidere l'app dal task manager e riaprirla; fare di nuovo login se necessario | Il modale **non** riappare (flag `softAskSeen` persistito in AsyncStorage) | ☐ PASS / ☐ FAIL |
| 3.4 | Verificare che il banner di promemoria sia invece visibile (notifiche ancora `denied`) | Banner presente in Scadenze e nel detail intervento (il banner non è legato al flag `softAskSeen`) | ☐ PASS / ☐ FAIL |

---

## Caso 4 — Banner di promemoria: Scadenze + detail intervento; dismiss per sessione; riappare al riavvio

**Precondizioni:** notifiche OS non concesse (stato `denied`); il modale è già
stato visto e `softAskSeen` impostato (oppure fare "Non ora" al Caso 3 prima);
account con almeno un intervento officina visibile.

### 4A — Tab Scadenze

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 4.1 | Navigare alla tab **Scadenze** | Il banner di promemoria è visibile in cima alla tab; testo: "Attiva le notifiche per ricevere aggiornamenti sui tuoi interventi e promemoria per le scadenze." | ☐ PASS / ☐ FAIL |
| 4.2 | Tap sul **corpo del banner** | Il prompt OS appare (status ancora `denied` — il sistema può mostrarlo) | ☐ PASS / ☐ FAIL |
| 4.3 | Rifiutare il prompt OS (tap "Non consentire") | Il banner rimane visibile (lo status non è cambiato) | ☐ PASS / ☐ FAIL |
| 4.4 | Tap sulla **"×"** (dismiss) a destra del banner | Il banner scompare dalla tab Scadenze | ☐ PASS / ☐ FAIL |
| 4.5 | Navigare in un'altra tab e tornare a Scadenze nella stessa sessione | Il banner rimane **nascosto** (dismiss è per-sessione, non persistito) | ☐ PASS / ☐ FAIL |
| 4.6 | Uccidere l'app e riaprirla; navigare a Scadenze | Il banner **riappare** (il dismiss per-sessione non è persistito tra riavvii) | ☐ PASS / ☐ FAIL |

### 4B — Detail intervento officina

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 4.7 | Tab Veicoli → veicolo → aprire un intervento officina | Il banner di promemoria è visibile in cima alla schermata detail; testo: "Attiva le notifiche per ricevere aggiornamenti sui tuoi interventi e promemoria per le scadenze." | ☐ PASS / ☐ FAIL |
| 4.8 | Tap sulla **"×"** del banner | Il banner scompare dalla schermata detail | ☐ PASS / ☐ FAIL |
| 4.9 | Tornare alla lista e riaprire lo stesso o un altro intervento | Il banner riappare (dismiss per-sessione: ogni istanza è indipendente) | ☐ PASS / ☐ FAIL |

---

## Caso 5 — Path blocked: banner apre Impostazioni; modale non appare se blocked

**Precondizioni:** portare il device nello stato `blocked` — il modo più rapido
è rifiutare il prompt OS due volte (al primo e al secondo tentativo), oppure
disabilitare le notifiche in Impostazioni → App → GarageOS → Notifiche.
Verificare che il toggle sia su OFF nelle Impostazioni prima di procedere.
`softAskSeen` non deve essere impostato (o può esserlo — in entrambi i casi
il modale non deve apparire quando blocked).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 5.1 | Login (o riaprire la app) con notifiche OS in stato `blocked` | Il modale soft-ask **non appare** (blocked esclude la soft-ask) | ☐ PASS / ☐ FAIL |
| 5.2 | Navigare alla tab **Scadenze** | Il banner di promemoria è visibile; testo: "Le notifiche sono disattivate. Apri le impostazioni per abilitarle." | ☐ PASS / ☐ FAIL |
| 5.3 | Tap sul **corpo del banner** | Si apre la schermata Impostazioni di sistema dell'app (pagina Notifiche); nessun prompt OS | ☐ PASS / ☐ FAIL |
| 5.4 | Nelle Impostazioni OS, abilitare le notifiche per GarageOS; tornare all'app | Il banner di promemoria **scompare** dalla tab Scadenze (invalidazione AppState-active) | ☐ PASS / ☐ FAIL |
| 5.5 | Navigare al detail di un intervento | Nessun banner di promemoria visibile (stato ora `granted`) | ☐ PASS / ☐ FAIL |

---

## Caso 6 — Regressione: toggle Notifiche in Profilo ancora funzionante

**Precondizioni:** notifiche OS concesse (stato `granted`); toggle push in
Profilo → Notifiche attualmente OFF o ON (verificare lo stato iniziale).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 6.1 | Profilo → **Notifiche** → toggle "Notifiche push dispositivo" | Se era OFF: tap → prompt OS (status `denied`) oppure, se status già `granted` da Caso 2/5, si attiva senza prompt; il toggle passa su ON | ☐ PASS / ☐ FAIL |
| 6.2 | Toggle ON → OFF | Il toggle si disabilita correttamente (il token push viene deregistrato) | ☐ PASS / ☐ FAIL |
| 6.3 | Portare lo status a `blocked` (disabilitare da Impostazioni OS) e tornare all'app; Profilo → Notifiche | Sotto il toggle appare il testo suggerimento "Vai alle impostazioni del dispositivo per abilitare le notifiche." (o testo equivalente) | ☐ PASS / ☐ FAIL |
| 6.4 | Il toggle in stato `blocked` → tap | Il toggle non si attiva; viene mostrato l'hint Impostazioni (comportamento immutato dal refactor) | ☐ PASS / ☐ FAIL |

---

## Stato prod post-smoke

Annotare qui i dati di test lasciati in prod da pulire:

- Account usato per lo smoke: ___
- Eventuali token push registrati/deregistrati da revocare se necessario: ___
- Note: ___

## Esiti

_(Da compilare dopo l'esecuzione)_
