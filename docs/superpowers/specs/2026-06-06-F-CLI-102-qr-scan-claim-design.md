# F-CLI-102 — QR scan claim veicolo (design)

**Data:** 2026-06-06
**Feature:** F-CLI-102 (Aggiunta veicolo via QR) — PR3 del filone claim
**Dipende da:** F-CLI-101 PR1 API claim (PR #159, `POST /v1/me/vehicles/claim`) +
F-CLI-101 PR2 UI claim manuale (PR #160, `ClaimVehicleForm` / `useClaimVehicle` /
route `app/claim-vehicle.tsx`).

## Contesto

L'endpoint `POST /v1/me/vehicles/claim` (BR-042) è il backend comune dei tre flussi di
acquisizione veicolo (codice manuale F-CLI-101 / QR F-CLI-102 / link invito F-CLI-103):
il client invia sempre **solo il codice estratto**. La UI manuale è già in prod (#160).

Questa PR aggiunge la **scansione QR** che auto-popola il codice nel form esistente.
Il QR del tag fisico del veicolo contiene un URL del tipo
`https://app.garageos.it/v/GO-482-KXRT` (Specifiche §4.5, riga 816): **non è un token di
autenticazione**, è solo l'identificatore del veicolo. La sicurezza resta lato endpoint
(stato/ownership app-layer + `uq_ownership_vehicle_active`, BR-040): chi ha il QR può
leggere il codice ma non può prendere possesso se il veicolo è già di un altro account
(→ `409 owned_by_other`).

Slice **mobile-only, additiva**. Una sola dipendenza nuova (`expo-camera`). Zero backend,
zero schema, nessuna modifica all'endpoint o alla route `claim-vehicle.tsx`.

### Contratto endpoint (invariato, già in prod)

`POST /v1/me/vehicles/claim` — body `{ garageCode: string }` (camelCase), normalizzato
server-side `trim().toUpperCase()` + regex BR-020 `^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$`.
200 → `{ vehicle, ownership, status: 'claimed' | 'already_owned' }`. Errori RFC7807 dotted:
`code_not_found` (404), `owned_by_other` (409), `pending` (422), `archived` (422).

## Decisioni di design (approvate)

1. **Post-scan = pre-compila + conferma.** Uno scan valido popola il campo codice del
   form esistente; il cliente **rivede e tocca "Aggiungi"** per confermare. Allineato alla
   spec ("auto-popola il codice" + §4.5 "registrarsi e confermare"). Riusa interamente il
   flusso di claim/navigazione di #160.
2. **Scan lanciato dal form + camera inline.** Il form claim (già raggiunto da header `+` /
   CTA EmptyState) guadagna un bottone "Scansiona QR". La camera è un overlay full-screen
   nello **stesso** screen (stato `showScanner` dentro `ClaimVehicleForm`). Nessuna nuova
   route, nessun param-passing cross-route → si evita il gotcha `router.d.ts`.
3. **Toggle dentro `ClaimVehicleForm` (approccio a).** Il codice estratto deve finire nello
   stato `code` del campo, che vive nel form → il form possiede il toggle e setta il proprio
   stato. Tutta la logica camera è isolata nel componente `QrScanner`, mockabile nei test del
   form.
4. **Validazione allo scan, non solo al submit.** Un QR estraneo (lattina, manifesto) non
   deve pre-popolare il campo con spazzatura: il parser estrae+valida e lo scanner accetta
   solo un codice che passa la regex; altrimenti mostra "QR non riconosciuto" e riarma.

## Architettura

### 1. Dipendenza `expo-camera`

Installata con `expo install expo-camera` (pin SDK-matched, ~16.0.x per SDK 52; **mai**
`pnpm add` a versione arbitraria — lezione #100 SDK drift). Modulo ufficiale Expo,
**bundlato in Expo Go** → smoke via sideload invariato, nessuna dev build necessaria.
`newArchEnabled:true` è supportato da expo-camera su SDK 52.

`app.json` — aggiungere il plugin con la stringa permesso IT (serve per build standalone
future; in Expo Go il permesso è runtime):

```jsonc
"plugins": [
  "expo-router",
  "expo-secure-store",
  ["expo-camera", { "cameraPermission": "Consenti a GarageOS di usare la camera per scansionare il QR del tag veicolo." }]
]
```

`expo-barcode-scanner` (citato nella tabella stack della spec) è **deprecato** e assorbito
da expo-camera: si usa `CameraView` con `barcodeScannerSettings`/`onBarcodeScanned`.

### 2. Helper puro `src/lib/qr.ts`

```ts
import { GARAGE_CODE_RE } from '@/lib/validators/claimVehicle';

// Estrae il codice GarageOS da un payload QR. Il tag codifica un URL
// https://app.garageos.it/v/GO-482-KXRT (Specifiche §4.5), ma accettiamo anche
// il codice nudo per robustezza/tag custom. Ritorna il codice normalizzato
// (trim+upper) se valido, null altrimenti.
export function extractGarageCode(raw: string): string | null {
  if (!raw) return null;
  // ultimo segmento di path, senza query/hash
  const lastSeg = raw.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  const code = lastSeg.trim().toUpperCase();
  return GARAGE_CODE_RE.test(code) ? code : null;
}
```

Richiede di **esportare** `GARAGE_CODE_RE` da `validators/claimVehicle.ts` (oggi è
const di modulo, non esportata) per non duplicare la regex. DB/camera-free, unit-testabile.

### 3. Componente `src/components/QrScanner.tsx`

```ts
type Props = { onScanned: (code: string) => void; onCancel: () => void };
```

Incapsula tutta la logica camera. `useCameraPermissions()` (da `expo-camera`) discrimina:

- **`null`/undetermined** → schermata con bottone "Consenti accesso camera"
  (`requestPermission()`).
- **granted** → `<CameraView style={StyleSheet.absoluteFill}
  barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={handle} />`
  full-screen + cornice mirino (View bordata) + testo "Inquadra il QR sul tag del veicolo" +
  bottone "Annulla" (`onCancel`).
- **denied** (`!granted && !canAskAgain`, o request rifiutata) → messaggio "Permesso camera
  negato. Inserisci il codice manualmente." + "Apri impostazioni" (`Linking.openSettings()`)
  + "Annulla".

`handleBarcodeScanned({ data })`:
1. **guard one-shot**: `if (handled) return; setHandled(true)` (onBarcodeScanned spara in
   raffica — senza guard si processa lo stesso QR decine di volte).
2. `const code = extractGarageCode(data)`.
3. valido → `onScanned(code)` (il parent chiude lo scanner + setta il campo).
4. `null` → `setHint('QR non riconosciuto')` + **riarma** lo scan
   (`setHandled(false)` dopo un attimo o al prossimo frame distinto) così il cliente può
   ripuntare senza riaprire. Non chiama `onScanned`, non chiude.

### 4. Wiring in `ClaimVehicleForm` (esteso)

Estensione del componente esistente (#160), inserimento manuale invariato:

- Nuovo stato `const [showScanner, setShowScanner] = useState(false)`.
- Bottone "Scansiona QR" (`Pressable` + `Ionicons name="qr-code-outline"`) sopra il campo
  codice → `setShowScanner(true)`.
- Quando `showScanner`, rende `<QrScanner onScanned={onScan} onCancel={() => setShowScanner(false)} />`
  come overlay full-screen (`StyleSheet.absoluteFill`) sopra il form.
- `onScan(code)`: `setCode(code); setShowScanner(false); setFieldError(undefined); setBanner(null);`
  → il campo è popolato, il cliente tocca "Aggiungi" (flusso esistente → `onSubmit` →
  `router.replace` al dettaglio).

`ClaimVehicleForm` resta l'unico componente toccato del flusso; `claim-vehicle.tsx`,
`useClaimVehicle`, `validateClaimForm`, mapping errori → nessuna modifica.

### 5. Stringhe IT

Nessuna nuova voce in `error-messages.ts` (i code-branch dell'endpoint sono già mappati da
#160). Stringhe UI hardcoded nel componente, coerenti con lo stile esistente (l'app non ha
ancora i18n centralizzato per le label statiche):
"Scansiona QR", "Consenti accesso camera", "Inquadra il QR sul tag del veicolo",
"QR non riconosciuto", "Permesso camera negato. Inserisci il codice manualmente.",
"Apri impostazioni", "Annulla".

## Testing (TDD)

- **`extractGarageCode`** (unit, `src/lib/qr.test.ts`):
  - URL `https://app.garageos.it/v/GO-482-KXRT` → `GO-482-KXRT`.
  - URL con `/` finale e/o query `?x=1` → estrae il codice.
  - codice nudo `GO-482-KXRT` → invariato; lowercase `go-482-kxrt` → uppercased.
  - testo random, char vietati (`GO-100-ABCD`, `GO-234-ABIO`), URL estranea
    (`https://example.com/promo`) → `null`.
- **`QrScanner`** (component, `CameraView` + `useCameraPermissions` **mockati** via
  `jest.mock('expo-camera', …)`):
  - permesso undetermined → bottone "Consenti accesso camera"; tap chiama `requestPermission`.
  - granted → rende il mock di `CameraView`.
  - denied → messaggio + "Apri impostazioni".
  - scan valido (mock invoca `onBarcodeScanned({ data: 'https://app.garageos.it/v/GO-234-ABCD' })`)
    → `onScanned('GO-234-ABCD')`.
  - scan invalido (`data: 'https://example.com'`) → messaggio "QR non riconosciuto",
    `onScanned` NON chiamato.
  - secondo scan consecutivo ignorato (one-shot guard).
- **`ClaimVehicleForm`** (component, `jest.mock('@/components/QrScanner')` → stub che rende
  un bottone "scan-stub" il cui press chiama `onScanned('GO-234-ABCD')`):
  - il bottone "Scansiona QR" monta lo scanner.
  - lo scan popola il `TextInput` codice con `GO-234-ABCD`.
  - i test manuali esistenti (validazione, banner per code-branch, submitting) restano verdi.

Esecuzione: jest mobile locale (redirect a file controllato + loop `grep __EXIT` —
l'output-file del background tarda), poi `pnpm -r typecheck`, poi CI per la matrice completa.

## Fuori scope (esplicito)

- Deep-link / link invito F-CLI-103 (PR4).
- Generazione del QR/tag lato officina (F-OFF-104, F-OFF-108).
- Pre-registrazione veicolo pending (F-CLI-104).
- Qualsiasi modifica backend, schema o all'endpoint claim.
- i18n centralizzato delle label statiche (non esiste ancora in app).

## Rischi / note

- **Mock jest di `expo-camera`**: `CameraView` e `useCameraPermissions` vanno mockati
  esplicitamente (jest-expo non fornisce un mock utile out-of-the-box). Manual mock per-test
  o in un file di setup; pattern simile al mock di `@react-native-community/datetimepicker`
  (#155).
- **One-shot guard** obbligatorio: `onBarcodeScanned` spara su ogni frame finché il QR è
  inquadrato.
- **`expo install` pin SDK-matched**: verificare che la versione installata sia quella attesa
  per SDK 52 (no drift — lezione #100). La dep è la **prima non puramente additiva** del
  mobile → giustificata in PR (modulo Expo ufficiale, in spec, Expo-Go-compatibile).
- **Smoke device**: in Expo Go il permesso camera è runtime; verificare grant + scan reale
  di un QR contenente `https://app.garageos.it/v/<codice>` (o codice nudo) → campo popolato →
  "Aggiungi" → dettaglio. Testare anche permesso negato (fallback manuale) e QR estraneo
  ("QR non riconosciuto").
- `app.json` plugin: il cambio non impatta Expo Go (permesso runtime) ma è necessario per
  build standalone future; va comunque committato ora.
