# F-OFF-309 — Export PDF intervento — Smoke runbook

Operator-driven post-deploy verification for F-OFF-309 export PDF intervento.

**Tipo:** manuale operatore, post-deploy. BLOCKER prima di considerare F-OFF-309 completo.

### Pre-condizioni

Deploy prod #135 (API) + questa PR (web) verdi. Login operatore officina (pool officine). Almeno un
intervento `active`, uno `cancelled`, e — se disponibile — un tenant con `logo_url` valorizzato e
uno senza.

### Step 1 — Export base (intervento active)

1. Apri `/interventions/:id` di un intervento `active`.
2. Click "Esporta PDF".

Atteso: nuova tab con PDF; nessun errore inline.

### Step 2 — Intestazione tenant e logo

1. Ispeziona l'intestazione del PDF appena generato.

Atteso: ragione sociale + indirizzo + P.IVA officina presenti. Se il tenant ha `logo_url` valido →
logo visibile; se assente o non risolvibile → solo intestazione testo (nessun crash).

**Nota IAM (logo):** questo è l'unico step che esercita realmente `s3:GetObject` del logo dalla
Lambda (l'integration test lo mockava). Se il logo non appare nonostante `logo_url` valido e
l'oggetto esista, sospetta un gap IAM `GetObject` sul prefix del logo (grant attesa bucket-wide
`${bucket}/*` da `lambda-api.ts`).

### Step 3 — Accenti italiani

1. Individua nel PDF testo con caratteri accentati (à è ì ò ù).

Atteso: renderizzati correttamente — nessun `?` o tofu.

### Step 4 — Note interne escluse

1. Apri un intervento con `internal_notes` valorizzate.
2. Esporta il PDF.

Atteso: le note interne NON compaiono nel PDF.

### Step 5 — Intervento cancelled

1. Apri un intervento `cancelled`.
2. Esporta il PDF.

Atteso: PDF generato con banner "INTERVENTO ANNULLATO — \<motivo\>".

### Step 6 — Sezione ricambi

1. Esporta un intervento con ricambi.

Atteso: lista ricambi corretta, SENZA costi.

2. Esporta un intervento senza ricambi.

Atteso: sezione ricambi assente.

### Step 7 — Intestatario

1. Esporta un intervento il cui veicolo ha un proprietario in anagrafica del tenant.

Atteso: nome proprietario corretto.

2. Se disponibile, esporta un intervento il cui proprietario NON è in anagrafica del tenant.

Atteso: "Proprietario non in anagrafica".

### Status

- [ ] Step 1 — export base OK
- [ ] Step 2 — intestazione tenant e logo OK
- [ ] Step 3 — accenti italiani OK
- [ ] Step 4 — note interne escluse OK
- [ ] Step 5 — intervento cancelled OK
- [ ] Step 6 — sezione ricambi OK (con ricambi + senza)
- [ ] Step 7 — intestatario OK

**Esito:** registrare PASS/FAIL per ogni step. Qualsiasi FAIL = blocker.
