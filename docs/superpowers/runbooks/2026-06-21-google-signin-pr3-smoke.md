# Smoke runbook — Google Sign-In PR3 Mobile (BLOCKER)

**Stato: DA ESEGUIRE**

Verifica su device reale del flusso OAuth "Accedi/Registrati con Google" lato
app mobile: nuovo utente, utente esistente, account merge (PreSignUp linking),
refresh di sessione, annullamento e regressione login nativo.

> **BLOCKER:** richiede un **dev build** installato sul device Xiaomi
> (`CI659HAE8LSW6H5L`, package `it.garageos.mobile`). **Non Expo Go**: lo
> scheme `garageos://` viene intercettato dall'app nativa solo in una build
> compilata; in Expo Go il deep link `garageos://auth/callback` passa
> attraverso il proxy `exp://` e Cognito non lo riconosce come redirect URI.

---

## Prerequisiti

### 1. Build dev

```bash
# Terminal 1: avviare Metro
pnpm --filter @garageos/mobile start

# Terminal 2: compilare e installare la build debug sul device
pnpm --filter @garageos/mobile android
# equivale a: expo run:android (debug variant, JS live da Metro)

# Terminal 3: abilitare il reverse proxy Metro sul device
adb reverse tcp:8081 tcp:8081
```

> **Gotcha:** se Metro non riflette le modifiche dopo l'installazione,
> verificare `adb reverse` (da `feedback_adb_reverse_drops_stale_bundle`):
> un drop di USB è sufficiente a invalidare il tunnel.

Il bundle punta a produzione:
- API: `https://api.garageos.aifollyadvisor.com`
- Cognito Hosted UI: `https://garageos-production-clienti.auth.eu-central-1.amazoncognito.com`
- Deep link callback: `garageos://auth/callback`

### 2. Account di test necessari

| Alias | Email | Ruolo nel test |
|---|---|---|
| **Account A — nuovo Google** | Un account Gmail mai usato su GarageOS | Caso 1 |
| **Account B — Google esistente** | Account Gmail già passato per Caso 1 | Caso 2 |
| **Account C — password esistente** | `matulamichele+b2cpwd@gmail.com` (Cognito user con email confermata) | Casi 3, 6 |

### 3. Stato Cognito / backend

- PR2 già deployata su `main` (il main stack, construct Cognito in `infrastructure/lib/constructs/cognito.ts`): Google IdP
  attivo, PreSignUp e PreTokenGeneration lambda wired.
- Secret `garageos/production/google-oauth` presente in Secrets Manager.
- Verificare:
  ```bash
  aws cognito-idp describe-identity-provider \
    --user-pool-id <POOL_ID> \
    --provider-name Google \
    --region eu-central-1
  ```

### 4. Variabili d'ambiente del bundle dev

Il bundle dev legge gli env da `.env.local` al momento del bundle. Verificare:
```
EXPO_PUBLIC_COGNITO_CLIENTI_POOL_ID=...
EXPO_PUBLIC_COGNITO_CLIENTI_CLIENT_ID=...
EXPO_PUBLIC_COGNITO_HOSTED_UI=https://garageos-production-clienti.auth.eu-central-1.amazoncognito.com
```

---

## Caso 1 — Nuovo utente Google

> Email Gmail mai vista da GarageOS. Verifica: PreSignUp crea `customers`,
> PreTokenGeneration inietta `custom:customer_id`.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 1.1 | Aprire l'app → schermata Login | Pulsante "Accedi con Google" visibile sotto il divisore "oppure" | |
| 1.2 | Tap "Accedi con Google" | Browser in-app (Custom Tab) si apre sul Hosted UI Google | |
| 1.3 | Selezionare/autenticare Account A | OAuth redirect → il browser si chiude automaticamente | |
| 1.4 | App atterra su `/(tabs)` | Tab bar visibile, nessun banner di errore | |
| 1.5 | Verificare DB: `SELECT id, email FROM customers WHERE email = '<email Account A>';` | Riga presente, `custom_id` = `custom:customer_id` nel JWT | |
| 1.6 | Verificare JWT: token decodificato contiene `custom:customer_id` != "" | Claim presente e non vuoto | |
| 1.7 | Lista veicoli: schermata vuota con CTA "Aggiungi veicolo" | Stato vuoto (nessun veicolo per l'account nuovo) | |

---

## Caso 2 — Utente Google esistente (ri-login)

> Stesso account Google già passato per il Caso 1. Verifica: nessun duplicato
> creato, stesso profilo/veicoli.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 2.1 | Sign out dall'app (Profilo → Esci) | App torna alla schermata Login | |
| 2.2 | Tap "Accedi con Google" | Browser in-app apre Hosted UI | |
| 2.3 | Selezionare Account A (o già auto-selezionato da Google) | Redirect automatico se sessione Google attiva; browser si chiude | |
| 2.4 | App atterra su `/(tabs)` | Stesso stato di Caso 1 (stessi veicoli, stesso profilo) | |
| 2.5 | SQL: `SELECT count(*) FROM customers WHERE email = '<email Account A>';` | Esattamente 1 riga (nessun duplicato) | |

---

## Caso 3 — Merge (email con password → Google)

> Account C ha già un'email confermata via login nativo. Verifica:
> PreSignUp linking collega il provider Google all'utente esistente — stesso
> `customer_id`, stessi veicoli, nessun doppione.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 3.1 | Accedere prima con email/password dell'Account C (`matulamichele+b2cpwd@gmail.com`) | Login nativo OK → `/(tabs)` | |
| 3.2 | Verificare `customerId` attuale (Profilo o log) e annotarlo | `customer_id` = `<ID_C>` | |
| 3.3 | Sign out | Login screen | |
| 3.4 | Tap "Accedi con Google" → selezionare l'account Google associato alla stessa email dell'Account C | Browser in-app apre Hosted UI | |
| 3.5 | Autenticarsi con Google | PreSignUp lambda rileva email coincidente, collega il provider | |
| 3.6 | App atterra su `/(tabs)` | Nessun banner errore | |
| 3.7 | Verificare `custom:customer_id` nel JWT è lo stesso `<ID_C>` | Stesso account — nessun nuovo `customers` creato | |
| 3.8 | SQL: `SELECT count(*) FROM customers WHERE email = '<email C>';` | Esattamente 1 riga | |
| 3.9 | I veicoli dell'Account C sono visibili | Stessa lista veicoli del login nativo | |

> **Nota:** se Account C non ha un'email Gmail, utilizzare un account
> `matulamichele+testgoogle@gmail.com` creato ad hoc con registrazione
> nativa preventiva.

---

## Caso 4 — Refresh di sessione Google

> Verifica che `refreshSession` (cognito.ts) rinnovi il `idToken` senza
> richiedere un nuovo login OAuth. Punto di rischio documentato (Deviation 3
> del piano): il refresh token di Cognito Hosted UI ha semantica diversa dal
> SRP refresh.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 4.1 | Effettuare un login Google (Caso 1 o 2) | App in `/(tabs)`, token in SecureStore | |
| 4.2 | Forzare la scadenza del `idToken`: aprire DevMenu (shake device), scegliere "Reload" senza sign-out oppure attendere >1h con l'app in background | `idToken` scaduto (exp < now), `refreshToken` ancora valido | |
| 4.3 | Eseguire una qualsiasi richiesta API (es. aprire lista veicoli) | `api-client` rileva 401 → chiama `refresh()` → `refreshSession` → nuovo `idToken` | |
| 4.4 | Richiesta API restituisce i dati correttamente senza login prompt | Refresh trasparente riuscito | |
| 4.5 | Verificare nei log Metro: nessun errore `NotAuthorizedException`; compare invece un log (se presente) del refresh silente | Nessun loop di login | |

> ⚠️ **Se il refresh fallisce:** `refreshSession` lancia un errore catturato
> da `api-client` → l'utente viene rimandato a Login. In questo caso, il
> fallback è `/oauth2/token` con `grant_type=refresh_token` via fetch diretta
> al Hosted UI endpoint — annotare il fallimento qui e aprire un issue.
> Il fallback non è implementato in questa PR; la navigazione a Login è il
> comportamento di degradazione accettabile.

---

## Caso 5 — Annullamento

> Chiudere il browser prima del completamento OAuth. Verifica: nessun crash,
> nessun banner di errore (il cancel è silente per design).

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 5.1 | Tap "Accedi con Google" | Browser in-app si apre | |
| 5.2 | Premere il tasto Back Android (o swipe down su Chrome Custom Tab) prima di scegliere account | Browser si chiude | |
| 5.3 | App torna alla schermata Login | Nessun banner errore, nessun crash, loading spinner fermato | |
| 5.4 | Login nativo funziona normalmente dopo il cancel | Nessun effetto collaterale | |

> `signInWithGoogle` lancia `{ code: 'auth.google.cancelled' }` → `handleGoogle`
> in login.tsx e signup.tsx sopprime il messaggio per questo codice.

---

## Caso 6 — Regressione login nativo

> Verifica che email/password native non siano state rotte dal wiring Google.

| # | Azione | Atteso | Esito |
|---|---|---|---|
| 6.1 | Schermata Login → inserire email Account C + password corretta | Login nativo procede senza toccare il browser | |
| 6.2 | App atterra su `/(tabs)` | Stesso flusso di prima dell'introduzione del pulsante Google | |
| 6.3 | Sign out → login con credenziali errate | Banner errore "Email o password non corretti." | |
| 6.4 | Navigare a Registrazione → "Registrati con Google" visibile | Pulsante presente anche in signup.tsx | |

---

## Stato prod post-smoke

Annotare qui i dati di test da pulire:

- Account Google creati durante il Caso 1 (IDs customers): ___
- Eventuali provider Cognito da scollegare manualmente se test Caso 3 fallisce: ___
- Pulizia account di test:
  ```sql
  -- Rimuovere i customers di test (cascade rimuove le righe correlate)
  DELETE FROM customers WHERE email IN ('<email Account A>');
  -- Poi da Cognito console: Users → cerca per email → Delete
  ```

---

## Esiti

_(Da compilare dopo l'esecuzione)_
