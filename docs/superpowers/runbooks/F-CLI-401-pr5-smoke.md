# Smoke runbook — F-CLI-401 PR5 mobile transfer full flow (BLOCKER)

E2e a due account su device reale (Expo Go sideloaded SDK 52, `adb reverse tcp:8081`,
Metro con `npx expo start --offline`), API prod. Account A = venditore (possiede un
veicolo certificato), Account B = cessionario.

## Pre-requisiti
- [ ] Account A con almeno un veicolo certificato di cui è owner attivo.
- [ ] Account B cliente registrato, loggato su un secondo device o in sessione alternata.

## Flusso venditore (A)
- [ ] a. Detail veicolo → tab Dati tecnici → bottone "Trasferisci proprietà" visibile sotto export PDF.
- [ ] b. Tap → schermata riepilogo (label veicolo + avviso 7 giorni) → "Avvia trasferimento" → codice TR-XXXX-XXXX in evidenza.
- [ ] c. "Condividi" apre lo share sheet di sistema col messaggio (codice + veicolo + scadenza).
- [ ] d. "Fine" → dettaglio transfer: badge "In attesa del nuovo proprietario", codice + Condividi + "Annulla trasferimento".
- [ ] e. Tornare alla detail veicolo → al posto del bottone c'è il banner "Trasferimento in corso" → tap → dettaglio.
- [ ] f. Profilo → riga "Trasferimenti" → lista con la card del transfer (veicolo, badge, data).

## Flusso cessionario (B)
- [ ] g. Aggiungi veicolo (claim) → digitare il codice TR- → submit → auto-redirect a "Accetta trasferimento" col codice precompilato.
- [ ] h. "Verifica" → card veicolo (targa/marca/modello) + scadenza. NO PII venditore.
- [ ] i. "Accetta" → esito "In attesa della conferma del venditore".
- [ ] j. Il veicolo NON compare ancora nella lista veicoli di B (proprietà ferma, BR-043).

## Conferma venditore (A)
- [ ] k. Lista trasferimenti → pull-to-refresh → badge "In attesa della tua conferma".
- [ ] l. Dettaglio → "Conferma passaggio" → dialog "passerà definitivamente" → conferma.
- [ ] m. Stato → "Completato"; il veicolo SPARISCE dalla lista veicoli di A (invalidazione ['me','vehicles']).
- [ ] n. Su B: pull-to-refresh lista veicoli → il veicolo COMPARE. Storico officina visibile; interventi privati di A NON visibili (F-CLI-405).

## Rami alternativi
- [ ] o. Nuovo transfer su altro veicolo → "Annulla trasferimento" in pending_recipient → dialog → stato "Rifiutato"; bottone "Trasferisci proprietà" torna disponibile sulla detail veicolo.
- [ ] p. Transfer accettato da B → A "Rifiuta" in pending_seller_confirmation → stato "Rifiutato", proprietà ferma.
- [ ] q. Codice inesistente ben formato (es. TR-AAAA-2222) → "Codice o trasferimento non valido. Controlla e riprova."
- [ ] r. Codice proprio (A inserisce il suo TR) → "Questo trasferimento è stato avviato da te."

## Verifica claim green-path (nota checkpoint 2026-06-10)
- [ ] s. Dopo lo swap (step m): verificare che il claim GO-code green-path (`claimed` nuovo su veicolo certificato senza owner) resti NON testabile — lo swap è atomico, non esiste mai una finestra a zero owner. Annotare qui l'esito: ____
