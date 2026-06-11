# Smoke runbook — F-CLI-401 PR5 mobile transfer full flow (BLOCKER)

> **ESEGUITO E PASS 2026-06-10 — 19/19 step.** Device Xiaomi `CI659HAE8LSW6H5L`, Expo Go
> SDK 52 sideloaded, Metro `npx expo start --offline` + `adb reverse tcp:8081`, API prod.
> Account A (venditore) = `matulamichele+cliente1@gmail.com`; Account B (cessionario) =
> `matulamichele+b2cpwd@gmail.com` ("Pippo Baudo", account pre-esistente dal vecchio smoke
> b2c password — NON è servito crearne uno nuovo). Green path con codice `TR-GMHT-FKGB`.
> Rami alternativi o/p/q/r eseguiti **a ruoli invertiti** (post-swap il proprietario è B,
> che ha avviato i transfer #2 e #3; A non aveva altri veicoli certificati).
> **Post-smoke: il veicolo resta di proprietà di B (customer `731b3cb3`)** — eventuale
> giro di ritorno verso A non eseguito.

E2e a due account su device reale (Expo Go sideloaded SDK 52, `adb reverse tcp:8081`,
Metro con `npx expo start --offline`), API prod. Account A = venditore (possiede un
veicolo certificato), Account B = cessionario.

## Pre-requisiti
- [x] Account A con almeno un veicolo certificato di cui è owner attivo.
- [x] Account B cliente registrato, loggato su un secondo device o in sessione alternata.

## Flusso venditore (A)
- [x] a. Detail veicolo → tab Dati tecnici → bottone "Trasferisci proprietà" visibile sotto export PDF.
- [x] b. Tap → schermata riepilogo (label veicolo + avviso 7 giorni) → "Avvia trasferimento" → codice TR-XXXX-XXXX in evidenza.
- [x] c. "Condividi" apre lo share sheet di sistema col messaggio (codice + veicolo + scadenza).
- [x] d. "Fine" → dettaglio transfer: badge "In attesa del nuovo proprietario", codice + Condividi + "Annulla trasferimento".
- [x] e. Tornare alla detail veicolo → al posto del bottone c'è il banner "Trasferimento in corso" → tap → dettaglio.
- [x] f. Profilo → riga "Trasferimenti" → lista con la card del transfer (veicolo, badge, data).

## Flusso cessionario (B)
- [x] g. Aggiungi veicolo (claim) → digitare il codice TR- → submit → auto-redirect a "Accetta trasferimento" col codice precompilato.
- [x] h. "Verifica" → card veicolo (targa/marca/modello) + scadenza. NO PII venditore.
- [x] i. "Accetta" → esito "In attesa della conferma del venditore".
- [x] j. Il veicolo NON compare ancora nella lista veicoli di B (proprietà ferma, BR-043).

## Conferma venditore (A)
- [x] k. Lista trasferimenti → pull-to-refresh → badge "In attesa della tua conferma".
- [x] l. Dettaglio → "Conferma passaggio" → dialog "passerà definitivamente" → conferma.
- [x] m. Stato → "Completato"; il veicolo SPARISCE dalla lista veicoli di A (invalidazione ['me','vehicles']).
- [x] n. Su B: pull-to-refresh lista veicoli → il veicolo COMPARE. Storico officina visibile; interventi privati di A NON visibili (F-CLI-405).

## Rami alternativi
- [x] o. Nuovo transfer su altro veicolo → "Annulla trasferimento" in pending_recipient → dialog → stato "Rifiutato"; bottone "Trasferisci proprietà" torna disponibile sulla detail veicolo. *(Eseguito da B sul veicolo trasferito, transfer #2.)*
- [x] p. Transfer accettato da B → A "Rifiuta" in pending_seller_confirmation → stato "Rifiutato", proprietà ferma. *(Eseguito a ruoli invertiti: transfer #3 avviato da B, accettato da A, rifiutato da B; veicolo rimasto a B.)*
- [x] q. Codice inesistente ben formato (es. TR-AAAA-2222) → "Codice o trasferimento non valido. Controlla e riprova."
- [x] r. Codice proprio (A inserisce il suo TR) → "Questo trasferimento è stato avviato da te." *(Eseguito da B col proprio transfer #2.)*

## Verifica claim green-path (nota checkpoint 2026-06-10)
- [x] s. Dopo lo swap (step m): verificare che il claim GO-code green-path (`claimed` nuovo su veicolo certificato senza owner) resti NON testabile — lo swap è atomico, non esiste mai una finestra a zero owner. Annotare qui l'esito: **CONFERMATO 2026-06-10** — A (ex proprietario) ha tentato il claim GO-code del veicolo trasferito: claim respinto, nessun green-path `claimed`. Lo swap atomico non lascia mai il veicolo a zero owner; il ramo green-path resta coperto solo dai test automatici.
