# Smoke notification tap deep-link (build standalone preview)

**Stato: ✅ ESEGUITO E PASS 2026-06-12 — feature chiusa (vedi Esiti)**

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

**Eseguito 2026-06-12 — PASS 7/7 (a-g).** Build EAS preview `b81840c0`
(post-merge #197), device Xiaomi, account Pippo Baudo
(`matulamichele+b2cpwd@gmail.com`).

- a. Install APK dal link build page + login + permesso notifiche +
  toggle ON: OK.
- b. Background, trigger PATCH intervento `a2a66c05` dal web prod
  (super_admin): tap → detail intervento. PASS.
- c. App KILLED, stesso trigger: tap → cold start direttamente sul detail
  intervento (fallback Android `trigger.remoteMessage.data.body` validato
  — unico percorso non coperto dai test). PASS.
- d. Foreground: la notifica viene CONSEGNATA (icona status bar + tendina;
  prima di #197 veniva ingoiata) e il tap dalla tendina naviga al detail.
  PASS funzionale. ⚠️ **Finding minor**: nessun banner heads-up a video,
  nemmeno con "notifiche flottanti" MIUI abilitate → il canale Android
  default ha importance DEFAULT. Candidato micro-fix futuro:
  `Notifications.setNotificationChannelAsync('default', { importance: MAX })`
  all'init (JS-only ma serve nuova build per verificarlo). Non bloccante.
- e. Push tool Expo con `deadline.reminder` + deadlineId/vehicleId reali
  (da SQL editor): tap → tab Scadenze con riga evidenziata azzurra e
  scrollata in vista. PASS.
- f. Logout prima del tap: tap → schermata login, nessun crash, nessuna
  navigazione post-login (by design). PASS.
- g. Payload malformato `{"type":"boh"}`: app si apre normalmente, nessun
  crash. PASS.

Note operative: le notifiche dal push tool Expo arrivano anche a token
deregistrato lato server (vanno dirette via Expo) — atteso per il test f/g.
Il PATCH di smoke ha aggiunto ~3 revisioni di test all'intervento
`a2a66c05` (già candidato pulizia DB prod).
