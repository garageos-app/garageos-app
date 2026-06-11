# Smoke runbook — F-CLI-104 Pre-registrazione veicolo pendente (PR1)

**Stato: ESEGUITO E PASS 11/11 — 2026-06-11** (device Xiaomi `CI659HAE8LSW6H5L`, Expo Go SDK 52 sideloaded, Metro `--offline` + `adb reverse`, API/dati prod, account A `matulamichele+cliente1@gmail.com`, account B `+b2cpwd@` "Pippo Baudo")

**Scope:** flusso completo pre-registrazione dal device + stato pending in
lista/dettaglio. API già coperta da integration su CI; qui si valida la UX
reale (form, errori IT, navigazione, badge/banner).

## Setup (standard Expo Go sideloaded)

1. `pnpm --filter @garageos/mobile exec expo install --check` — drift noti
   `@types/react@19` e `react-native-get-random-values@2.0.0` sono
   intenzionali, NON fixare.
2. Device collegato USB: `adb reverse tcp:8081 tcp:8081`
3. `cd packages/mobile; npx expo start --offline` (senza `--offline` chiede
   login Expo e blocca il bundle)
4. Login app con account cliente di test (`matulamichele+cliente1@...` o
   `+b2cpwd@...` "Pippo Baudo" — pool clienti `eu-central-1_vBdWRi9Kj`)

## Step

| # | Azione | Atteso | Esito |
|---|---|---|---|
| a | Lista veicoli → "Aggiungi veicolo" (claim) | Sotto il form claim c'è il link "Non hai il codice? Pre-registra il veicolo" | PASS |
| b | Tap sul link | Si apre "Pre-registra veicolo" con 5 campi testo + chip Tipo veicolo + chip Alimentazione | PASS |
| c | Submit con tutto vuoto | Errori "Campo obbligatorio" per-campo; nessuna chiamata API | PASS |
| d | VIN 16 caratteri | Errore campo "Il telaio (VIN) deve essere di 17 caratteri (senza I, O, Q)" | PASS |
| e | VIN 17 char con checksum errato (es. `1M8GDM9A1KP042788`) + resto valido → submit | Banner server "Il VIN non risulta valido. Controlla il libretto di circolazione." | PASS |
| f | Pre-registrazione reale: VIN checksum-valido NON esistente (es. `1M8GDM9AXKP042788` se libero — verificare!), targa formato `AB123CD`, marca/modello/anno, chip selezionati → "Pre-registra" | Redirect al dettaglio veicolo; banner "Veicolo in attesa di certificazione…"; NESSUNA riga "Codice:" nell'header | PASS |
| g | Back → lista veicoli | Il veicolo appare con pill ambra "In attesa di certificazione" | PASS |
| h | Dettaglio → tab Dati tecnici | Riga "Codice GarageOS: Non ancora assegnato"; export PDF funziona (storico vuoto) | PASS |
| i | Tab Dati tecnici → sezione trasferimento → tenta avvio transfer | Errore IT "Questo veicolo non può ancora essere trasferito." (degradazione accettata da spec — il gating UI arriverà se serve) | PASS |
| j | Ripeti pre-registrazione con lo STESSO VIN dello step f | Banner "Esiste già un veicolo registrato con questo telaio…" | PASS |
| k | Login account cliente B → lista veicoli | Il veicolo di A NON appare | PASS |

## Post-smoke

- ⚠️ Il veicolo pending creato allo step f resta in **prod**: annotare qui VIN
  e vehicle id. NON cancellarlo subito — è la fixture naturale per lo smoke
  PR2 (certify reale lato officina). Dopo lo smoke PR2 entra nella pulizia DB
  prod insieme a F-OFF-102/transfer (vedi checkpoint).
- VIN usato: `1M8GDM9AXKP042788`  vehicle id: da recuperare via Supabase SQL
  editor (`SELECT id FROM vehicles WHERE vin = '1M8GDM9AXKP042788';`) quando
  servirà allo smoke PR2 — nessuna credenziale DB prod in locale.

## Esiti

**PASS 11/11 — 2026-06-11.** Device Xiaomi `CI659HAE8LSW6H5L`, Expo Go SDK 52
sideloaded, Metro `npx expo start --offline` + `adb reverse tcp:8081`, API e
dati prod. Account A `matulamichele+cliente1@gmail.com` (step a-j), account B
`matulamichele+b2cpwd@gmail.com` "Pippo Baudo" (step k, isolamento confermato).
Nessuna anomalia. Veicolo pending creato allo step f lasciato in prod come
fixture per lo smoke PR2 (F-OFF-107 certify).

Nota di sessione (non un finding): al primo avvio l'app girava con un bundle
Expo Go in cache pre-merge e il link dello step a non compariva — risolto
ricaricando il progetto dal dev server (`adb shell am start -a
android.intent.action.VIEW -d "exp://127.0.0.1:8081"` se il progetto è stato
rimosso dai recenti di Expo Go).
