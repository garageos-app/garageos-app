# Smoke notification tap deep-link (build standalone preview)

**Stato: ⬜ DA ESEGUIRE — BLOCKER per la chiusura della feature**

Verifica su device del routing dal tap sulla notifica push alla schermata
target, più il banner foreground. Il codice è JS-only ma il bundle è cotto
nell'APK standalone: serve una **NUOVA build EAS preview** post-merge (la
build `71e50abc` del 2026-06-11 NON contiene questa feature).

## Prerequisiti

- Setup EAS/FCM one-time già fatto (vedi `push-e2e-smoke.md` §Prerequisiti:
  projectId in `app.config.js`, FCM V1 key, env EAS preview).
- Nuova build: `npx eas-cli@latest build --profile preview --platform android`
  da `packages/mobile` (gotcha monorepo in memoria
  `feedback_eas_build_monorepo_gotchas`: pin node/pnpm in `eas.json`,
  shamefully-hoist root — già a posto da #194).
- Install APK dal link della build page sul device (no adb necessario).
- Account con veicolo e intervento officina: `matulamichele+b2cpwd@gmail.com`
  (Pippo Baudo) come per lo smoke push e2e.

## Routing atteso (tabella di riferimento)

| Evento | Tap apre |
|---|---|
| `intervention.revised` / `intervention.cancelled` | Detail intervento `/interventions/<id>` |
| `deadline.reminder` | Tab Scadenze, riga evidenziata (tinta azzurra) + scroll |
| `ownership.transferred` | Tab Veicoli (lista) |
| payload sconosciuto/malformato | App si apre normalmente, nessun crash |

## Step

a. **Build + install** APK preview nuovo sul device; login Pippo Baudo;
   permesso notifiche ON; toggle push device ON in Profilo → Notifiche.
b. **Tap con app in BACKGROUND**: dal web prod (super_admin) PATCH di un
   intervento officina di un veicolo posseduto con motivazione ≥10 char →
   push `intervention.revised` → tap → atteso: app in foreground sul
   **detail di quell'intervento**.
c. **Tap da APP KILLED**: uccidere l'app dal task manager → ripetere il
   trigger → tap sulla notifica → atteso: cold start direttamente sul detail
   intervento (passa per splash/auth loading; il target deve sopravvivere).
   ⚠️ Questo step valida il fallback Android `trigger.remoteMessage.data.body`
   — è il percorso che NESSUN test automatico copre.
d. **Banner FOREGROUND**: con l'app aperta in primo piano, ripetere il
   trigger → atteso: banner di sistema visibile (prima veniva ingoiata);
   tap sul banner → naviga al detail.
e. **deadline.reminder + highlight**: inviare una push con il tool Expo
   (https://expo.dev/notifications, token del device da `push_tokens`) con
   `data` esatto: `{"type":"deadline.reminder","deadlineId":"<id reale da
   deadlines del cliente>","vehicleId":"<vehicleId>"}` → tap → atteso: tab
   Scadenze con la riga della scadenza **tinta azzurra** e scrollata in vista.
   (Se il cliente non ha scadenze: crearne una dal web, o accettare il
   fallback "lista normale senza highlight" con un deadlineId inesistente.)
f. **Tap da SLOGGATO**: logout (deregistra il token) → re-login → toggle ON →
   logout di nuovo NON serve; in alternativa: con push tool inviare una
   notifica, fare logout PRIMA di tapparla, poi tap → atteso: schermata
   login, nessun crash, nessuna navigazione post-login (decisione design:
   login semplice, no defer).
g. **Payload legacy/malformato**: push tool con `data: {"type":"boh"}` →
   tap → app si apre normalmente (lista veicoli o login), nessun crash.

## Esiti

_(da compilare all'esecuzione)_
