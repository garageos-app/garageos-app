# Smoke runbook — F-CLI-104 Pre-registrazione veicolo pendente (PR1)

**Stato: DA ESEGUIRE** (BLOCKER post-merge — UI mobile, nessuna review sostituisce lo smoke device)

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
| a | Lista veicoli → "Aggiungi veicolo" (claim) | Sotto il form claim c'è il link "Non hai il codice? Pre-registra il veicolo" | |
| b | Tap sul link | Si apre "Pre-registra veicolo" con 5 campi testo + chip Tipo veicolo + chip Alimentazione | |
| c | Submit con tutto vuoto | Errori "Campo obbligatorio" per-campo; nessuna chiamata API | |
| d | VIN 16 caratteri | Errore campo "Il telaio (VIN) deve essere di 17 caratteri (senza I, O, Q)" | |
| e | VIN 17 char con checksum errato (es. `1M8GDM9A1KP042788`) + resto valido → submit | Banner server "Il VIN non risulta valido. Controlla il libretto di circolazione." | |
| f | Pre-registrazione reale: VIN checksum-valido NON esistente (es. `1M8GDM9AXKP042788` se libero — verificare!), targa formato `AB123CD`, marca/modello/anno, chip selezionati → "Pre-registra" | Redirect al dettaglio veicolo; banner "Veicolo in attesa di certificazione…"; NESSUNA riga "Codice:" nell'header | |
| g | Back → lista veicoli | Il veicolo appare con pill ambra "In attesa di certificazione" | |
| h | Dettaglio → tab Dati tecnici | Riga "Codice GarageOS: Non ancora assegnato"; export PDF funziona (storico vuoto) | |
| i | Tab Dati tecnici → sezione trasferimento → tenta avvio transfer | Errore IT "Questo veicolo non può ancora essere trasferito." (degradazione accettata da spec — il gating UI arriverà se serve) | |
| j | Ripeti pre-registrazione con lo STESSO VIN dello step f | Banner "Esiste già un veicolo registrato con questo telaio…" | |
| k | Login account cliente B → lista veicoli | Il veicolo di A NON appare | |

## Post-smoke

- ⚠️ Il veicolo pending creato allo step f resta in **prod**: annotare qui VIN
  e vehicle id. NON cancellarlo subito — è la fixture naturale per lo smoke
  PR2 (certify reale lato officina). Dopo lo smoke PR2 entra nella pulizia DB
  prod insieme a F-OFF-102/transfer (vedi checkpoint).
- VIN usato: `__________________`  vehicle id: `__________________`

## Esiti

(compilare a esecuzione avvenuta: data, device, account, PASS/FAIL per step,
anomalie)
