# Appendice F — Business Logic Rules

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Le regole qui contenute sono normativamente valide per l'implementazione e prevalgono in caso di ambiguità nelle altre sezioni.
>
> **Versione:** v1.0 — allineata a `GarageOS-Specifiche.md` v1.0
> **Ultimo aggiornamento:** 22 aprile 2026

---

## Scopo di questo documento

Questo documento raccoglie in modo **esplicito e inequivocabile** tutte le regole di business del sistema GarageOS. Ogni regola è:

- **Numerata** con codice univoco (`BR-XXX`) per poter essere referenziata in codice e test
- **Categorizzata** per area funzionale
- **Descritta** nel cosa fare e nel perché
- **Tradotta** in pseudocodice dove utile
- **Collegata** alle funzionalità `F-XXX-YYY` della Sezione 3 del documento master

**Quando implementare una funzionalità, controllare prima se esistono regole applicabili in questa appendice.** Ogni ambiguità rilevata in fase di sviluppo deve essere risolta aggiungendo una nuova regola in questo documento, non con una decisione estemporanea.

---

## Indice

1. [Regole sui veicoli](#1-regole-sui-veicoli)
2. [Regole sul codice GarageOS](#2-regole-sul-codice-garageos)
3. [Regole sulla proprietà e passaggi](#3-regole-sulla-proprietà-e-passaggi)
4. [Regole sugli interventi](#4-regole-sugli-interventi)
5. [Regole sugli interventi privati](#5-regole-sugli-interventi-privati)
6. [Regole sulle scadenze](#6-regole-sulle-scadenze)
7. [Regole sulle contestazioni](#7-regole-sulle-contestazioni)
8. [Regole sugli accessi e privacy](#8-regole-sugli-accessi-e-privacy)
9. [Regole sugli allegati](#9-regole-sugli-allegati)
10. [Regole sui tenant e utenti](#10-regole-sui-tenant-e-utenti)
11. [Regole sui customer](#11-regole-sui-customer)
12. [Regole sulle notifiche](#12-regole-sulle-notifiche)
13. [Regole sull'audit log](#13-regole-sullaudit-log)

---

## 1. Regole sui veicoli

### BR-001 — Unicità VIN
Un veicolo è univocamente identificato dal VIN (Vehicle Identification Number, telaio). Il sistema rifiuta la creazione di due veicoli con lo stesso VIN.

**Validazione:** VIN di 17 caratteri, alfanumerico escluso `I`, `O`, `Q` (standard ISO 3779), controllo del checksum quando possibile.

**Eccezione:** veicoli storici pre-1981 o mezzi agricoli/speciali possono avere telai non standard. In questi casi il sistema accetta VIN di 11-17 caratteri senza checksum, ma richiede conferma esplicita del meccanico (`force_nonstandard_vin: true`).

### BR-002 — Targa non univoca
La targa di un veicolo **non è chiave univoca**. Può esistere lo stesso numero di targa su veicoli diversi nel tempo (ritargatura, reimmatricolazione estera).

**Implementazione:** la ricerca per targa può restituire 0, 1 o N risultati. In caso di N risultati, mostrare disambiguazione via VIN + data immatricolazione.

### BR-003 — Stato iniziale del veicolo
Un veicolo creato da un'officina è in stato `certified` immediatamente (al momento della creazione, l'officina ha il libretto in mano e verifica i dati).

Un veicolo creato da un customer (modalità utente-first) è in stato `pending` fino alla certificazione da parte di un'officina.

### BR-004 — Promozione da pending a certified
Solo un'officina autorizzata (`Tenant User` con ruolo `super_admin` o `mechanic`) può promuovere un veicolo da `pending` a `certified`.

**Precondizioni per la promozione:**
- Il veicolo deve essere in stato `pending`
- Il meccanico deve aver visionato fisicamente il libretto di circolazione (dichiarazione esplicita via checkbox "Ho visionato il libretto")
- I dati del veicolo (VIN, targa, marca, modello, anno) devono essere verificati e corretti — correggibili durante la promozione

**Post-condizioni:**
- `status` diventa `certified`
- `certified_by_tenant_id` = tenant del meccanico
- `certified_at` = timestamp corrente
- `garage_code` viene generato (vedi sezione 2)
- Notifica push+email al customer che possiede il veicolo

### BR-005 — Immutabilità del VIN post-certificazione
Una volta che un veicolo è in stato `certified`, il VIN **non può più essere modificato** da alcun utente, neanche Super Admin.

**Motivazione:** il VIN è l'identificatore fisico del veicolo. Modificarlo significa che stiamo parlando di un altro veicolo.

**Procedura in caso di errore di VIN certificato:** archiviare il veicolo errato (status `archived`), creare un nuovo record corretto, migrare manualmente lo storico solo se necessario (operazione admin).

### BR-006 — Dati veicolo sempre richiesti
I seguenti campi sono **obbligatori** alla creazione di un veicolo certificato: `vin`, `plate`, `make`, `model`, `year`, `vehicle_type`, `fuel_type`, `odometer_km` iniziale.

Per veicoli pending sono obbligatori: `vin`, `plate`, `make`, `model`, `year`.

### BR-007 — Anno di fabbricazione
`year` deve essere compreso tra **1900 e anno corrente + 1** (un veicolo non può essere di un anno troppo passato o troppo futuro).

### BR-008 — Archivio veicoli
Un veicolo in stato `archived` (demolito, esportato, rottamato) **non può essere aggiornato** (niente nuovi interventi, niente scadenze).

La ricerca non lo restituisce di default (serve flag `include_archived: true`).

Lo storico resta visibile per sempre, ma l'etichetta "ARCHIVIATO" è mostrata ovunque.

**L'archiviazione può essere richiesta da:**
- Il proprietario attuale via app
- Un'officina durante una revisione (es. esito negativo con "veicolo non più idoneo")
- Team admin per veicoli palesemente abbandonati

---

## 2. Regole sul codice GarageOS

### BR-020 — Formato del codice
Il codice GarageOS ha formato **`GO-NNN-AAAA`** dove:
- `NNN` = 3 cifre decimali, escluse `0` e `1` (quindi 8 cifre effettive: 2,3,4,5,6,7,8,9)
- `AAAA` = 4 lettere maiuscole, escluse `I`, `O`, `Q`, `S`, `U` (quindi 21 lettere effettive)

**Combinazioni disponibili:** 8³ × 21⁴ = 512 × 194.481 = ~99,6 milioni di codici univoci.

**Regex validator:** `/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/`

**Esempi validi:** `GO-482-KXRT`, `GO-739-MNPL`, `GO-234-ABCD`
**Esempi non validi:** `GO-012-KXRT` (contiene 0 e 1), `GO-482-KXRI` (contiene I)

### BR-021 — Generazione del codice
La generazione del codice GarageOS avviene **in transazione atomica** al momento della certificazione del veicolo:

```
1. Genera random(NNN) + random(AAAA) usando PRNG sicuro (crypto.randomBytes)
2. Costruisci la stringa GO-NNN-AAAA
3. Tenta INSERT nel DB con vincolo UNIQUE su garage_code
4. Se fallisce per conflitto: retry fino a 3 volte
5. Se dopo 3 retry ancora fallisce: throw error + alert operations
```

**Motivazione del retry:** con 120M combinazioni e <100k veicoli previsti a lungo termine, probabilità di collisione pratica nulla. Il retry protegge da edge case.

### BR-022 — Immutabilità del codice
Il `garage_code` **non è mai modificabile** dopo la generazione, neanche da admin.

**Motivazione:** il codice è stato consegnato al cliente su tag fisico, stampato su PDF, condiviso in vendite. Modificarlo romperebbe tutti questi riferimenti.

### BR-023 — Riuso del codice dopo archiviazione
Il `garage_code` di un veicolo archiviato **non viene riutilizzato**. Rimane associato al record archiviato.

**Motivazione:** un acquirente di usato potrebbe cercare il codice di un veicolo che poi è stato archiviato per verificare lo storico; deve ancora trovarlo.

### BR-024 — Ricerca per codice
La ricerca per `garage_code` è **case-insensitive** (GO-482-KXRT == go-482-kxrt == Go-482-Kxrt). L'output è sempre normalizzato a uppercase.

**Implementazione:** ogni input viene `.toUpperCase()` prima della query.

### BR-025 — Display del codice
Il codice è sempre visualizzato con i trattini nel formato `GO-NNN-AAAA`. Nei QR code è memorizzato come URL `https://app.garageos.it/c/GO-NNN-AAAA` (non solo il codice raw).

---

## 3. Regole sulla proprietà e passaggi

### BR-040 — Un solo proprietario attivo per veicolo
Per ogni veicolo, esiste **al massimo una** entry in `vehicle_ownership` con `ended_at IS NULL`.

**Enforcement:** partial unique index `UNIQUE (vehicle_id) WHERE ended_at IS NULL`.

**Eccezione v2:** co-intestazione (più proprietari). Richiede modello dati diverso, rimandato a v2.

### BR-041 — Proprietario durante censimento officina
Quando un'officina censisce un nuovo veicolo e crea anche il customer proprietario, il sistema crea automaticamente:
1. Nuovo `customer` (se non esistente con stessa email)
2. Nuovo `vehicle_ownership` con `started_at = now()`, `ended_at = NULL`
3. Nuova `customer_tenant_relation` che collega customer ↔ tenant

**Atomicità:** questa operazione è in **transazione unica** — se uno step fallisce, rollback completo.

### BR-042 — Claim del veicolo via codice (customer)
Quando un customer inserisce un codice GarageOS per reclamare un veicolo:

**Precondizioni:**
- Il codice deve esistere e corrispondere a un veicolo `certified`
- Il veicolo deve essere **libero** (nessun `vehicle_ownership` attivo), oppure il customer è già il proprietario attuale

**Casi:**

| Stato veicolo | Azione |
|---|---|
| Veicolo senza proprietario attivo | Crea nuovo `vehicle_ownership` con customer richiedente, started_at=now() |
| Veicolo già posseduto dal richiedente | Nessuna azione, restituisce successo idempotente |
| Veicolo già posseduto da altro customer | **Errore 409** `vehicle_already_owned_by_other`. Suggerisce flusso passaggio di proprietà o claim autonomo |
| Veicolo `pending` | **Errore 422** `vehicle_pending_not_claimable` (deve prima essere certificato) |
| Veicolo `archived` | **Errore 422** `vehicle_archived` |

### BR-043 — Passaggio di proprietà — flusso happy path
Il passaggio di proprietà "standard" richiede il **consenso di entrambe le parti**:

```
1. Vecchio proprietario (cedente) avvia il transfer via app
   → crea VehicleTransfer con status=pending_recipient
   → genera transfer_code OPPURE invia email all'invited_email
   → il VEICOLO NON viene ancora spostato

2. Nuovo proprietario (cessionario) accetta:
   - Via inserimento transfer_code, OPPURE
   - Via click su link email
   → status diventa pending_seller_confirmation
   → il VEICOLO NON è ancora spostato

3. Sistema notifica cedente: "Luigi Bianchi vuole acquisire il tuo veicolo, confermi?"

4. Cedente conferma:
   → status diventa completed
   → In transazione atomica:
       a) vehicle_ownership corrente: ended_at = now()
       b) Nuova vehicle_ownership: customer_id=cessionario, started_at=now()
       c) completed_at sul transfer
```

**Timeout:** se il cedente non conferma entro 7 giorni dall'accettazione del cessionario, il transfer scade (`status=expired`) e il veicolo resta al cedente.

### BR-044 — Passaggio di proprietà senza cedente
Se il cedente non è registrato o non disponibile, il cessionario può avviare un **claim autonomo**:

```
1. Cessionario avvia via app:
   - Inserisce codice GarageOS del veicolo
   - Carica foto libretto di circolazione (entrambi i lati)
   - Carica foto documento d'identità proprio
2. Sistema crea VehicleTransfer con status=pending_validation
3. Sistema OCR estrae dati dal libretto e li confronta con il veicolo nel sistema
4. Se coincidono: validazione automatica possibile (ma richiede comunque step 5)
5. Sistema notifica cedente attuale (se registrato):
   "Richiesta di trasferimento per il tuo veicolo X. Hai 7 giorni per contestare."
6. Attende 7 giorni:
   - Se il cedente conferma o non risponde: transfer approvato
   - Se il cedente contesta: escalation a team admin (status=pending_validation resta, gestione manuale)
7. Se validazione OK:
   → transazione atomica ownership transfer come BR-043
```

**Caso "cedente non registrato nel sistema":** il veicolo ha un `vehicle_ownership.customer_id` ma il customer non ha `cognito_sub` (non ha mai scaricato l'app). Il "timeout di 7 giorni" si applica con invio email semplice al customer. Se non risponde, trasferimento approvato automaticamente.

### BR-045 — Cosa viene trasferito e cosa no
Al completamento di un transfer:

**SI trasferisce (visibile al nuovo proprietario):**
- Storico completo interventi officina (cross-tenant, tutti)
- Scadenze aperte e future
- Dati tecnici del veicolo
- Audit log degli accessi futuri

**NON si trasferisce (nascosto al nuovo proprietario):**
- Dati personali del cedente (nome, email, telefono, indirizzo)
- Note riservate officine-cedente (`customer_tenant_relation.tenant_notes`)
- Interventi privati del cedente (`private_interventions`)
- Allegati degli interventi privati del cedente
- Audit log storico accessi precedenti il transfer
- Push token del cedente associati al veicolo

**Il cedente conserva:**
- Il suo account customer (non cancellato)
- Visibilità sugli interventi privati registrati (marcati come "veicolo ceduto")
- Notifica dell'avvenuto trasferimento

### BR-046 — Divieto di transfer veicoli pending
Non è possibile trasferire un veicolo in stato `pending` (vedi BR-042). Deve prima essere certificato.

### BR-047 — Transfer multipli
È possibile avere **solo un VehicleTransfer attivo per veicolo alla volta**. Stati attivi = `pending_recipient`, `pending_seller_confirmation`, `pending_validation`.

**Enforcement:** partial unique index `UNIQUE (vehicle_id) WHERE status IN ('pending_recipient', 'pending_seller_confirmation', 'pending_validation')`.

### BR-048 — Invalidazione transfer alla vendita
Se il proprietario avvia un transfer e poi cambia idea, può annullarlo via `POST /transfers/:id/reject` finché lo stato non è `completed`.

Se un customer prova a reclamare il veicolo tramite codice durante un transfer attivo → **errore 409** con riferimento al transfer in corso.

---

## 4. Regole sugli interventi

### BR-060 — Visibilità cross-tenant degli interventi officina
Tutti gli interventi officina (`interventions`) sono **visibili in lettura a qualsiasi tenant** del sistema, a condizione che il tenant stia consultando la scheda di un veicolo (non ricerca libera).

Gli interventi **non sono cross-tenant in scrittura**: solo il tenant che li ha creati può modificarli.

### BR-061 — Campi immutabili post-creazione
I seguenti campi di un intervento **non sono mai modificabili** dopo la creazione, nemmeno dal Super Admin, nemmeno nella finestra wiki:
- `vehicle_id` (su che veicolo)
- `intervention_date` (quando è stato fatto)
- `odometer_km` (km al momento)
- `tenant_id`, `location_id`, `user_id` (chi l'ha fatto)

**Motivazione:** questi campi definiscono l'essenza dell'evento storico. Modificarli significherebbe riscrivere la storia.

**Per correggere errori su questi campi:** annullare l'intervento (vedi BR-066) e crearne uno nuovo corretto.

### BR-062 — Finestra wiki
Un intervento è in **"finestra wiki"** (modifiche libere, non tracciate visibilmente al cliente) finché sono entrambe vere:
1. Sono passate meno di **48 ore** dalla creazione
2. Il cliente **non ha ancora aperto** l'intervento nell'app (`first_seen_by_customer_at IS NULL`)

Quando una delle due condizioni diventa falsa, il campo `wiki_locked_at` viene impostato al timestamp corrente.

**Pseudocodice:**
```typescript
function shouldLockWiki(intervention): boolean {
  if (intervention.wiki_locked_at !== null) return true;
  const age = now() - intervention.created_at;
  const seenByCustomer = intervention.first_seen_by_customer_at !== null;
  return age >= 48 * HOUR || seenByCustomer;
}
```

### BR-063 — Modifica in finestra wiki
Se l'intervento è in finestra wiki (`wiki_locked_at IS NULL`):
- L'officina può modificare i campi modificabili senza tracciamento
- Nessuna entry in `intervention_revisions` creata
- Nessuna notifica al cliente

### BR-064 — Modifica post-lock
Se l'intervento è bloccato (`wiki_locked_at IS NOT NULL`):
- L'officina può ancora modificare i campi modificabili
- **Ogni modifica crea una entry in `intervention_revisions`** con: user_id, revised_at, changes (diff campo-per-campo), reason (obbligatorio)
- Il cliente riceve notifica push+email "L'intervento X è stato modificato. Vedi cosa è cambiato."
- Le revisioni sono visibili al cliente nella vista dettaglio intervento

### BR-065 — Campi modificabili
I seguenti campi sono modificabili (con regole wiki vs revision):
- `intervention_type_id`
- `title`
- `description`
- `parts_replaced`
- `internal_notes` (solo officina — non richiede notifica cliente)

Le modifiche a `internal_notes` **non generano revisioni visibili al cliente**, perché il cliente non vede mai questo campo.

### BR-066 — Annullamento intervento (F-OFF-307)
Un intervento **non può essere cancellato fisicamente**. Può essere marcato come `cancelled`:
- Azione disponibile solo al `super_admin` del tenant che l'ha creato
- Richiede `cancelled_reason` testuale obbligatorio (min 20 caratteri)
- `cancelled_by_user_id` e `cancelled_at` popolati automaticamente
- L'intervento resta visibile in timeline con badge "ANNULLATO" e motivazione
- Il cliente riceve notifica push+email

**L'annullamento è irreversibile.** Per "annullare l'annullamento" bisogna creare un nuovo intervento identico.

### BR-067 — Relazione intervento ↔ scadenza
Un intervento può essere creato **collegato a una scadenza aperta** (`source_intervention_id` inverso: l'intervento completa la scadenza).

Regola di matching:
```
L'intervento X "chiude" la scadenza Y se:
- Y.vehicle_id == X.vehicle_id
- Y.intervention_type_id == X.intervention_type_id
- Y.status == 'open'
- |Y.due_date - X.intervention_date| ≤ 90 giorni OPPURE |Y.due_odometer_km - X.odometer_km| ≤ 5000
```

Al salvataggio di un intervento, se esiste una scadenza matching, il sistema propone al meccanico "Questo intervento chiude la scadenza del [data]?" con conferma.

**Il completamento della scadenza non è automatico** — richiede esplicita conferma del meccanico.

### BR-068 — Km non decrescenti (warning)
Quando si registra un intervento, il sistema verifica che `odometer_km` sia **≥ al massimo km degli interventi precedenti** sullo stesso veicolo (includendo sia officina che privati).

**Se km decrescenti:**
- Warning (non errore bloccante): "Hai inserito 42.000 km ma l'ultimo intervento aveva 45.000 km. Sei sicuro?"
- Richiede conferma esplicita con flag `force_km_decrease: true`
- Se confermato, l'intervento viene creato e marcato con flag interno `km_anomaly: true`

**Motivazione:** anomalie legittime esistono (contachilometri guasto e sostituito, errore di lettura precedente), non vogliamo bloccare, ma vogliamo rilevare frodi km.

### BR-069 — Data intervento nel passato o presente
`intervention_date` deve essere **≤ data odierna**. Non sono ammessi interventi futuri.

**Eccezione:** appuntamenti futuri non sono interventi (sono scadenze/prenotazioni, fuori scope v1).

### BR-070 — Data intervento non troppo nel passato
`intervention_date` deve essere **≥ `vehicle.registration_date`**. Non si può fare un intervento su un veicolo prima che esistesse.

Se `registration_date` è NULL (veicoli storici), si accetta qualsiasi data passata.

### BR-071 — Parts_replaced formato
`parts_replaced` è un array JSON di oggetti:
```json
[
  {"name": "Olio motore 5W30", "code": "SEL-5W30", "quantity": 4, "notes": "Litri"}
]
```

**Vincoli:**
- `name` obbligatorio, max 200 caratteri
- `code` opzionale, max 50 caratteri
- `quantity` numero positivo (intero o decimale)
- `notes` opzionale, max 200 caratteri

**Array vuoto `[]` è valido** (intervento senza pezzi sostituiti, es. diagnosi, revisione).

---

## 5. Regole sugli interventi privati

### BR-080 — Proprietà esclusiva
Un intervento privato (`private_interventions`) è **di proprietà esclusiva del customer** che lo ha creato. Nessun altro utente o officina può vederlo, modificarlo o cancellarlo.

### BR-081 — Visibilità negli export
Gli interventi privati **non appaiono mai**:
- Negli export PDF condivisi con acquirenti usato
- Nei link di condivisione temporanei (`/public/vehicles/:share_token`)
- Nella timeline visibile alle officine

Appaiono solo nella timeline del customer proprietario.

### BR-082 — Permanenza al cambio di proprietà
Al passaggio di proprietà del veicolo:
- Gli interventi privati del cedente **restano associati al cedente** (non al nuovo proprietario)
- Nel profilo cedente, questi interventi sono marcati come "relativi a veicolo ceduto"
- Il nuovo proprietario non li vede mai

### BR-083 — Km negli interventi privati
Gli interventi privati **non concorrono** al controllo BR-068 (km non decrescenti) degli interventi officina, perché i km degli interventi privati sono auto-dichiarati e meno affidabili.

Vale il reciproco: un intervento privato può avere km qualsiasi senza warning.

### BR-084 — Cancellabilità
Gli interventi privati sono **cancellabili** dal customer proprietario senza restrizioni. Soft delete con `deleted_at`.

### BR-085 — Limite di rate (anti-spam)
Un customer può creare **max 50 interventi privati al giorno**. Oltre, error 429 — protezione contro script/abusi.

---

## 6. Regole sulle scadenze

### BR-100 — Almeno un criterio di scadenza
Una scadenza deve avere **almeno uno** tra `due_date` e `due_odometer_km` popolato. Può averli entrambi.

**Enforcement:** CHECK constraint nel DB.

### BR-101 — Scadenza matching dual criteria
Se una scadenza ha **entrambi** `due_date` e `due_odometer_km`, si considera scaduta al raggiungimento di **almeno uno** dei due (più restrittivo).

Esempio: "Tagliando entro 12 mesi O 15.000 km" → se il cliente fa 20.000 km in 8 mesi, la scadenza è dovuta.

### BR-102 — Schedulazione notifiche
Alla creazione di una scadenza con `due_date` valorizzato, il sistema crea automaticamente **3 schedule EventBridge** per notifiche:
- T-30 giorni: `due_date - 30 giorni`
- T-7 giorni: `due_date - 7 giorni`
- T-0: `due_date`

**Se `due_date` è a meno di 30 giorni da oggi:** solo le notifiche future vengono schedulate (es. se sono a 10 giorni, niente T-30, sì T-7 e T-0).

**Se `due_date` è nel passato:** nessuna notifica schedulata. La scadenza è creata ma marcata `overdue` immediatamente.

### BR-103 — Notifica solo su due_date (non su km)
Le notifiche automatiche T-30/T-7/T-0 si basano **solo su `due_date`**. Non esiste notifica automatica basata sui km (impossibile prevedere quando il cliente raggiungerà un certo km).

**Eccezione:** al raggiungimento del km target (se il cliente aggiorna km via F-CLI-107 oppure un intervento registra km ≥ target), il sistema invia **una notifica one-shot** "Hai raggiunto i km per la scadenza X".

### BR-104 — Completamento scadenza
Una scadenza si chiude con `status=completed` quando:
1. L'officina esplicitamente la marca come completata (BR-067), con `completed_by_intervention_id` popolato
2. Oppure manualmente da Super Admin del tenant creatore

**Non esiste completamento automatico** solo perché è passata la data target.

Quando una scadenza diventa `completed`:
- Tutti gli schedule EventBridge futuri vengono cancellati
- Se `is_recurring = true`, viene creata automaticamente una nuova scadenza con date/km incrementati

### BR-105 — Ricorrenza
Se `is_recurring = true`, alla chiusura viene creata una nuova scadenza con:
- `due_date` = completed_at + `recurring_months` mesi (se popolato)
- `due_odometer_km` = completed_by_intervention.odometer_km + `recurring_km` (se popolato)

La nuova scadenza è **del tenant che ha creato l'originale**, non necessariamente di chi ha completato.

### BR-106 — Scadenza diventa overdue
Una scadenza con `due_date < today()` e `status=open` transita automaticamente (via job periodico) a `status=overdue`.

**Non vengono inviate ulteriori notifiche** oltre T-0.

Una scadenza overdue è ancora chiudibile con un intervento (nessun effetto negativo sul veicolo nel sistema — la scadenza era solo un promemoria).

### BR-107 — Cancellazione scadenza
Una scadenza può essere cancellata (status=cancelled) da:
- Super Admin o Meccanico del tenant creatore
- Non richiede motivazione

Alla cancellazione, tutti gli schedule EventBridge futuri vengono cancellati.

**Il cliente non riceve notifica di cancellazione** (sarebbe rumore inutile — la notifica originale era "preparati a X", la cancellazione significa "non importa più").

### BR-108 — Limite scadenze aperte per veicolo
Non c'è limite al numero di scadenze aperte contemporanee per un veicolo. Un veicolo può avere scadenze per tagliando, revisione, cambio gomme, distribuzione, ecc. simultaneamente.

### BR-109 — Non-duplicazione scadenze
Se un'officina tenta di creare una nuova scadenza per un veicolo con **stesso `intervention_type_id` e scadenza aperta già esistente**, il sistema:
- Warning: "Esiste già una scadenza aperta per questo tipo (scadrà il X)"
- Richiede conferma esplicita con `force_duplicate: true`
- Se confermato, vengono create entrambe (l'officina si assume la responsabilità)

---

## 7. Regole sulle contestazioni

### BR-120 — Chi può contestare
Solo il **proprietario attuale** del veicolo (customer con `vehicle_ownership` attiva) può contestare un intervento.

**Eccezione:** un proprietario precedente non può contestare un intervento avvenuto durante la sua proprietà una volta ceduto il veicolo. La contestazione è "congelata" al momento del passaggio.

### BR-121 — Periodo di contestazione
Un intervento può essere contestato **in qualsiasi momento** dopo la creazione. Non c'è scadenza temporale.

**Motivazione:** il valore di fiducia del sistema dipende dalla possibilità di segnalare sempre anomalie.

### BR-122 — Una contestazione aperta per intervento per customer
Un customer può avere **al massimo una contestazione aperta** (`status=open` o `responded`) per ogni intervento.

Se una contestazione viene chiusa (`resolved_by_cancellation` o `escalated`), il customer può aprirne una nuova se emergono nuovi elementi.

### BR-123 — Categorie motivazione
`reason_category` è obbligatoria alla creazione. Valori ammessi:
- `not_performed` — "L'intervento non è mai stato effettuato"
- `wrong_data` — "I dati riportati sono errati (km, data, pezzi)"
- `not_authorized` — "Non ho autorizzato questo intervento / non ho mai portato l'auto qui"
- `other` — "Altro" (richiede descrizione più dettagliata)

**Rimossa** la categoria `overcharge` dal documento precedente, coerentemente con la scelta di non gestire costi (OPEN #4).

### BR-124 — Descrizione obbligatoria
`customer_description` è obbligatoria, min 20 caratteri, max 2000 caratteri.

### BR-125 — Stato iniziale e transizioni
```
[nuova contestazione] → open
     ↓ (officina risponde)
   responded
     ↓ (officina annulla intervento) → resolved_by_cancellation
     ↓ (non risponde entro 14gg) → escalated (gestione admin)
     ↓ (admin risolve) → closed_by_admin
```

### BR-126 — SLA risposta officina
L'officina ha **14 giorni** dalla creazione della contestazione per rispondere.

**Promemoria:**
- T+7 giorni: email di sollecito al Super Admin del tenant
- T+14 giorni: escalation automatica, status → `escalated`

### BR-127 — Stato intervento contestato
Quando c'è una contestazione aperta per un intervento:
- L'intervento ha `status=disputed` (oltre al proprio status eventuale)
- Il badge "CONTESTATO" è visibile in tutti i punti dove l'intervento appare
- Anche nel PDF esportato e nei link pubblici

### BR-128 — Storico contestazioni
Le contestazioni **non vengono mai cancellate fisicamente**. Anche dopo la risoluzione, restano visibili nel dettaglio intervento per trasparenza verso futuri acquirenti.

### BR-129 — Risposta officina
La risposta dell'officina (`tenant_response`) è obbligatoria, min 20 caratteri, max 2000 caratteri.

Può includere allegati (es. foto che provano l'intervento effettuato).

### BR-130 — Annullamento intervento come risoluzione
Se l'officina riconosce l'errore, può annullare l'intervento (BR-066). Questa azione:
- Cambia `intervention.status` a `cancelled`
- Cambia `dispute.status` a `resolved_by_cancellation`
- Notifica customer push+email

---

## 8. Regole sugli accessi e privacy

### BR-150 — Accesso ai dati tecnici del veicolo
Qualsiasi `Tenant User` può accedere (in lettura) ai dati tecnici e allo storico interventi officina di qualsiasi veicolo, tramite:
- Ricerca per `garage_code`
- Ricerca per `plate`
- Ricerca per `vin`

Ogni accesso registra una entry in `access_logs`.

### BR-151 — Accesso ai dati personali del proprietario
I dati personali del proprietario (`nome`, `cognome`, `email`, `phone`, `address_line`, ecc.) **sono visibili a un tenant solo se esiste una `customer_tenant_relation` attiva** tra tenant e customer.

**Stati che creano la relazione:**
- L'officina ha registrato almeno un intervento per quel customer (qualsiasi veicolo)
- Oppure l'officina ha creato il customer (censimento iniziale veicolo)

**Pseudocodice visibilità:**
```typescript
function canSeeCustomerPII(tenantId, customerId): boolean {
  return exists(customer_tenant_relations, {
    tenant_id: tenantId,
    customer_id: customerId
  });
}
```

### BR-152 — Creazione automatica della relazione
Quando un tenant registra un intervento su un veicolo di un customer con cui **non aveva relazione**, il sistema crea automaticamente la `customer_tenant_relation`.

**Attenzione:** il tenant vede i dati personali **solo dopo** questa prima registrazione, quindi il primo intervento deve essere registrato con dati acquisiti "in presenza" dal cliente (vedi flusso 4.3).

### BR-153 — Scheda veicolo cross-tenant
Quando un tenant accede alla scheda di un veicolo di cui NON è nella `customer_tenant_relation`, vede:

**VISIBILE:**
- Dati tecnici veicolo (marca, modello, VIN, targa, anno, ecc.)
- Storico interventi officina di tutti i tenant
- Scadenze aperte
- Status certificato/pending/archived

**NASCOSTO:**
- Dati personali proprietario (sostituiti con placeholder "Proprietario non in anagrafica")
- Email e telefono per contatto
- Indirizzo
- Note riservate di altri tenant

### BR-154 — Audit accessi ai veicoli
Ogni accesso a `GET /vehicles/:id` o `GET /vehicles/search` che restituisce match viene loggato:
```
{
  vehicle_id: ...,
  tenant_id: ...,
  location_id: ...,
  user_id: ...,
  action: 'view' | 'search_match',
  timestamp: ...,
  ip_address: ...
}
```

**Regola di deduplica:** accessi ripetuti dallo stesso `user_id` sullo stesso `vehicle_id` entro **30 minuti** vengono aggregati (un solo log con ultimo timestamp) per evitare inflazione log.

### BR-155 — Visibilità audit log al customer
Il customer proprietario vede nella sua app la lista degli accessi al suo veicolo. Formato mostrato:
- Nome tenant (obbligatorio)
- Città della location (obbligatorio)
- Tipo azione (view / new intervention)
- Data/ora
- Nome meccanico (opzionale — mostrato solo se `customer_tenant_relation` esiste)

**Non mostra:**
- IP address (solo admin)
- User agent
- ID interni (tenant_id, user_id)

### BR-156 — Nessuna notifica push per accessi
**Confermato**: gli accessi al veicolo **non generano notifica push** al customer, solo audit log in-app consultabile. Decisione OPEN #7.

### BR-157 — Notifica push SÌ per interventi
La creazione di un nuovo intervento officina **genera sempre** notifica push+email al customer proprietario:
- Titolo: "Nuovo intervento registrato sulla tua [modello]"
- Body: "[Tenant name] ha registrato: [tipo intervento]"
- Deep link alla scheda intervento

### BR-158 — Diritto all'oblio del customer
Quando un customer richiede la cancellazione del proprio account (F-CLI-006):

**Dati ANONIMIZZATI (non cancellati):**
- `first_name` → "Utente"
- `last_name` → "Cancellato"
- `email` → `deleted-<hash>@garageos.it`
- `phone` → NULL
- `tax_code` → NULL
- `address_*` → NULL
- `cognito_sub` → NULL
- `status` → `deleted`
- `deleted_at` → now()

**Dati CANCELLATI:**
- Push token
- Interventi privati e loro allegati

**Dati MANTENUTI (pseudonimizzati):**
- `customer.id` (resta referenziato da vehicle_ownership, ecc.)
- Vehicle_ownership con customer anonimizzato (lo storico proprietà è parte della storia del veicolo)
- Customer_tenant_relation con flag `customer_deleted=true`

**Motivazione:** la storia del veicolo sopravvive al suo proprietario per servire i futuri acquirenti. Il bilanciamento legittimo interesse vs diritto all'oblio è risolto con anonimizzazione.

---

## 9. Regole sugli allegati

### BR-180 — Dimensioni e formato
Un allegato:
- **Max 10 MB** per file
- **Max 10 allegati** per intervento (officina o privato)
- Formati accettati: `image/jpeg`, `image/png`, `image/heic`, `image/webp`, `application/pdf`
- Niente video, niente eseguibili, niente archivi

### BR-181 — Compressione automatica lato server
Per le immagini:
- Resize: lato lungo max **2048 pixel** (mantiene aspect ratio)
- Conversione: HEIC → WebP, PNG>1MB → WebP, altri → mantenuti
- Qualità: 85% per JPEG/WebP
- Thumbnail separata: 400x400 max, WebP qualità 75%

Per i PDF: mantenuti as-is (già compressi tipicamente).

### BR-182 — Chi può caricare
Allegati a `intervention`:
- Caricabili solo dal `tenant` che ha creato l'intervento
- Finché l'intervento è in finestra wiki (BR-062), caricamento libero
- Dopo lock wiki, upload ancora consentito ma crea una `intervention_revision` (l'aggiunta di allegati è una modifica tracciata)

Allegati a `private_intervention`:
- Caricabili solo dal customer proprietario

### BR-183 — Eliminazione allegati
- Officina può eliminare allegati dei propri interventi (in finestra wiki, libero; dopo, crea revisione)
- Customer può eliminare allegati dei propri interventi privati senza restrizioni
- L'eliminazione è soft (`deleted_at` nel DB), ma il file S3 viene schedulato per cancellazione fisica dopo 30 giorni (retention buffer per recovery)

### BR-184 — Accesso agli allegati (download)
Gli allegati sono acceduti via **presigned URL** temporanei (durata 15 minuti).

**Visibilità allegati intervento officina:**
- Caricatore (tenant): sempre
- Tutti i tenant che possono vedere l'intervento: sì (coerente con visibilità timeline)
- Customer proprietario: sì
- Customer futuri proprietari: sì
- Acquirenti di usato via link pubblico condiviso: sì (gli allegati sono parte dello storico)

**Visibilità allegati intervento privato:**
- Solo il customer proprietario
- MAI esposti in link pubblici o export

### BR-185 — Nessun filtro contenuti v1
In v1, non c'è scansione dei contenuti degli allegati (niente virus scan, niente content moderation).

**Roadmap v1.1+:** integrazione con AWS Rekognition o servizio simile per rilevare contenuti inappropriati, virus scan via AWS GuardDuty.

---

## 10. Regole sui tenant e utenti

### BR-200 — Un tenant ha sempre una location
Al momento della creazione di un tenant, viene creata automaticamente **una location primaria** (`is_primary=true`) usando i dati inseriti dal titolare nel form di signup.

### BR-201 — Una sola location primaria
Per ogni tenant esiste **esattamente una** location con `is_primary=true` e `status=active`.

**Enforcement:** partial unique index `UNIQUE (tenant_id) WHERE is_primary=true AND status='active'`.

Se il Super Admin disattiva la location primaria, deve prima designare un'altra location come primaria.

### BR-202 — Primo utente è Super Admin
Il primo utente creato con il tenant (dal flusso di signup) è automaticamente `role=super_admin`.

Non esiste tenant senza almeno un Super Admin.

### BR-203 — Almeno un Super Admin attivo
Un tenant deve sempre avere **almeno un `user` con `role=super_admin` e `status=active`**.

**Enforcement a livello applicativo:**
- Impossibile disattivare/eliminare l'ultimo Super Admin
- Impossibile cambiare ruolo dell'ultimo Super Admin
- Messaggio: "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente."

### BR-204 — Super Admin senza location specifica
Un Super Admin può avere `location_id=NULL` (amministra tutto il tenant).

Un Meccanico **deve** avere `location_id` popolato (assegnato a una sede specifica).

### BR-205 — Visibilità cross-location
**Super Admin:** vede tutti gli interventi, veicoli, clienti di qualsiasi location del proprio tenant.

**Meccanico:** vede solo gli interventi effettuati nella propria `location_id`. Può però:
- Cercare veicoli (la ricerca è cross-tenant per definizione)
- Vedere lo storico completo di un veicolo (indipendentemente dalla location)
- Registrare interventi solo nella propria location

### BR-206 — Invito utenti
Il Super Admin può invitare nuovi utenti via email. Il flusso effettivo (F-OFF-004):
1. Super Admin compila form: email, nome, cognome, ruolo, location
2. Sistema crea riga `invitations` con token valido 7 giorni — **NON** crea ancora una riga `users`
3. Email inviata con magic-link a `/accept-invitation?token=...`
4. Invitato clicca → GET `/v1/invitations/:token` mostra dettagli → POST `/v1/invitations/:token/accept` con password
5. Backend chiama `AdminCreateUser` + `AdminSetUserPassword` in Cognito, crea riga `users` con `status='active'` e `cognito_sub` popolato, marca `invitations.accepted_at`
6. Se link scada prima dell'attivazione: `invitation.expires_at < now()` → 410 Gone, super_admin deve creare un nuovo invito

> **Storage del token** (post PR2, 2026-05-20): il token del magic-link è memorizzato hashato (SHA-256) at-rest in `invitations.token_hash`. Il plaintext esiste soltanto nell'URL del magic-link spedito via SES e nel body della richiesta `AcceptInvitation`. La CLI operatore `scripts/admin/get-invitation-link.ts` ruota il token a ogni invocazione (riga di audit `user_invitation_token_rotated`). Vedi `docs/superpowers/specs/2026-05-20-pr2-token-hash-admin-disable-design.md`.

### BR-207 — Rimozione utente
Super Admin può rimuovere un utente (soft delete, `status=inactive` + `deleted_at`).

- L'utente **non può più accedere** (token invalidato)
- I suoi interventi passati **restano visibili** (l'intervento X è stato registrato dal meccanico Y, storicità preservata)
- Le sue scadenze create restano aperte

**La rimozione è reversibile via BR-212 nello stesso tenant.**

### BR-208 — Self-delete
Un utente può rimuovere se stesso (`DELETE /users/me`), ma:
- Se è l'ultimo Super Admin: errore (BR-203)
- Altrimenti: stesso comportamento di BR-207

### BR-209 — Cambio email utente
Il cambio email di un `user` richiede verifica della nuova email (flow Cognito standard). L'email vecchia resta valida per accedere fino alla verifica della nuova.

### BR-210 — Suspension tenant
Un tenant in stato `suspended` (da admin o per billing):
- I suoi utenti non possono fare login
- Gli interventi esistenti **restano visibili** ai customer proprietari dei veicoli (la storia non si cancella)
- Nessun nuovo intervento registrabile
- Gli schedule di notifiche future vengono **cancellati** (no promemoria inviati in nome di un tenant sospeso)
- Dopo 90 giorni di suspension continua → status `cancelled`

### BR-211 — Cancellazione tenant
Un tenant `cancelled` mantiene i dati per **10 anni** (retention legale/fiscale) poi cancellazione completa via job scheduled.

### BR-212 — Riattivazione utente (F-OFF-004 slice 2026-05-21)
Super Admin può riattivare un utente soft-deleted (`status=inactive`, `deleted_at IS NOT NULL`) nel proprio tenant via `POST /v1/users/:id/reactivate`.

**Effetto:**
- `deleted_at = NULL`, `status = 'active'`
- `AdminEnableUser` su Cognito (re-enable user)
- Optional override `{role?, locationId?}` per ri-decidere ruolo/sede al rientro
- Audit log `action='user_reactivated'`

**Vincoli:**
- BR-204 ricontrollato: mechanic richiede location active obbligatoria
- BR-203 non applicabile (reactivate aggiunge un super_admin, mai sottrae)

**Limitazione cross-tenant**: BR-212 risolve solo same-tenant. Per cross-tenant cohabitation vedi BR-213 (out-of-scope v1).

### BR-213 — Cross-tenant email collision (F-OFF-004 slice 2026-05-21)
Cognito Officine è single-pool (`eu-central-1_9Rd7nGpH8`) quindi email è alias globalmente unico nel pool.

**Conseguenza:**
- Un meccanico X attivo in Officina A NON può essere invitato in Officina B mentre X è attivo (Cognito `UsernameExistsException`).
- Anche dopo soft-delete in A, X non può essere invitato in B finché il Cognito user esiste.
- `POST /v1/users/invitations` rileva il caso via Cognito `AdminGetUser` early-check e restituisce `409 user.invitation.email_in_other_tenant`.

**Out-of-scope v1**: cross-tenant cohabitation richiederebbe rearchitect Cognito (pool-per-tenant o `custom:tenant_ids` list-attribute). Tracciato come F-OFF-XXX futuro.

---

## 11. Regole sui customer

### BR-220 — Email univoca
L'email di un customer è univoca nel sistema (un customer = una email). Non può esistere un altro customer attivo con la stessa email.

**Case:** customer A cancellato con `email=mario@rossi.it` (diventa `deleted-hash@garageos.it`) → un nuovo customer può registrarsi con `mario@rossi.it`.

### BR-221 — Registrazione senza veicolo
Un customer può registrarsi senza alcun veicolo associato. Il sistema non richiede il possesso di un veicolo per creare l'account.

### BR-222 — Un customer può avere N veicoli
Non c'è limite numerico ai veicoli posseduti da un customer. Edge case di test: 100+ veicoli devono funzionare in UI e API.

### BR-223 — Cliente aziendale
Se `is_business=true`:
- `business_name` e `vat_number` obbligatori
- `first_name` e `last_name` sono del referente legale (es. "Mario Rossi" = persona di contatto)
- La visualizzazione in UI antepone `business_name` a `first_name last_name`

### BR-224 — Customer senza Cognito account (shadow account)
Un customer può esistere senza aver mai scaricato l'app (`cognito_sub=NULL`). Creato da un'officina al primo intervento.

Stati di un customer:
- **Shadow account**: `cognito_sub=NULL`, `app_installed=false`. Riceve solo email. Non può loggarsi.
- **Invited**: inviato invito via email, non ancora registrato. Riceve solo email.
- **Active**: `cognito_sub` popolato, `app_installed=true`, ha almeno 1 login mobile. Riceve push+email.

### BR-225 — Promozione shadow → active
Quando un customer shadow riceve l'invito e si registra:
1. Customer trova l'invitation token nell'email → apre app
2. App fa login/signup con l'email → Cognito crea `cognito_sub`
3. Sistema verifica: esiste customer con quella email?
   - Sì → associa `cognito_sub` al customer esistente (promozione)
   - No → crea nuovo customer (fallback, non dovrebbe succedere)

**Non si creano duplicati** di customer per la stessa email.

### BR-226 — Notification preferences default
Alla creazione, un customer ha queste preferenze notifiche di default:
```json
{
  "email": {
    "intervention_updates": true,
    "deadline_reminder": true,
    "transfer_invitation": true,
    "dispute_response": true,
    "marketing": false
  },
  "push": {
    "intervention_updates": true,
    "deadline_reminder": true,
    "transfer_invitation": true,
    "dispute_response": true
  }
}
```

> **v1.3 (2026-05-08):** chiave `email.new_intervention` rinominata a `email.intervention_updates` (idem per `push`). Il toggle ora governa l'intero lifecycle dell'intervention (BR-040 create + BR-064 revise + BR-066 cancel) anziché la sola creazione. Migration data-only `20260508120000_rename_new_intervention_to_intervention_updates`.

Il customer può modificare queste preferenze via F-CLI-005.

---

## 12. Regole sulle notifiche

### BR-250 — Trigger notifica
Le notifiche vengono **sempre tentate su entrambi i canali** attivi (push + email), se le preferenze lo consentono.

**Eccezione:** se push fallisce (es. token invalido), non si fa fallback SMS in v1. Resta solo email.

### BR-260 — Opt-out obbligatorio per marketing
Email marketing (newsletter, novità prodotto) sono **opt-in**: default spenta, il customer deve attivare esplicitamente.

Email transazionali (notifiche importanti su scadenze, interventi, contestazioni) sono **opt-out** ma SEMPRE inviate per:
- Password reset
- Email confirm
- Transfer ownership invitation
- Invitation to app

Queste ultime non sono considerate "marketing" e non possono essere disattivate — sono informazioni necessarie per l'uso del servizio.

### BR-251 — Rate limiting per customer
Un customer non riceve **più di 5 email al giorno** dal sistema (escludendo email di sicurezza).

Se più eventi generano email nella stessa giornata, vengono raggruppate in un "digest" serale.

**Push notifications:** nessun rate limit hard, ma raggruppamento se 5+ eventi dello stesso tipo entro 1h.

### BR-252 — Lingua
Tutte le comunicazioni in **italiano** in v1. Il cliente non può cambiare lingua.

### BR-253 — Unsubscribe
Ogni email ha un link di unsubscribe in footer che porta direttamente alle preferenze notifiche. L'unsubscribe totale (da tutte le email non critiche) è sempre possibile.

### BR-254 — Push token lifecycle
Alla registrazione di un nuovo push token:
- Se il customer ha già un token per lo stesso device (stesso `device_name`): aggiornamento `expo_push_token`
- Altrimenti: nuova entry

Al fallimento di una push (token invalid/expired reported da Expo):
- Token marcato `active=false`
- Se tutti i token di un customer sono inactive: `customer.app_installed` → false

### BR-255 — Silenzio notturno (roadmap)
v1: nessuna logica di silenzio notturno.
v1.1: opzione per disattivare push in fascia oraria configurabile dal customer (default: nessun silenzio).

---

## 13. Regole sull'audit log

### BR-280 — Cosa viene loggato
Eventi sempre loggati in `audit_logs`:
- Creazione/modifica/cancellazione di tenant, location, user, customer
- Creazione/modifica/annullamento intervento
- Apertura/risposta/escalation contestazione
- Passaggio di proprietà (avvio, accettazione, conferma, rifiuto, scadenza)
- Claim veicolo (successo/fallimento)
- Login/logout utente
- Modifica preferenze notifiche
- Generazione link condivisione pubblica
- Ristampa tag codice GarageOS
- Accesso admin a funzionalità di supporto

### BR-281 — Cosa NON viene loggato in audit
- Letture normali (quelle vanno in `access_logs` per i veicoli)
- Consultazione scadenze proprie
- Navigazione UI

### BR-282 — Immutabilità
`audit_logs` e `access_logs` sono **append-only**. Nessun UPDATE o DELETE consentito.

**Enforcement:** policy PostgreSQL che rifiuta UPDATE e DELETE su queste tabelle.

### BR-283 — Retention audit log
- **12 mesi** in tabella accessibile (query veloci)
- Oltre 12 mesi: archiviazione automatica su S3 cifrato (via export mensile)
- **Retention totale 5 anni** (S3 Glacier dopo 12 mesi per cost optimization)
- Oltre 5 anni: cancellazione

### BR-284 — Accesso agli audit log
- Super Admin tenant: vede audit log del proprio tenant
- Admin GarageOS: vede audit log cross-tenant
- Customer: non vede audit log, vede solo `access_logs` dei propri veicoli in forma filtrata (BR-155)

---

## Appendice alla Appendice: template test case

Ogni regola business può (e dovrebbe) essere coperta da test. Template:

```typescript
describe('BR-040 — Un solo proprietario attivo per veicolo', () => {
  it('should reject a second active ownership on same vehicle', async () => {
    const vehicle = await createVehicle();
    const customer1 = await createCustomer();
    const customer2 = await createCustomer();

    await createOwnership({ vehicle_id: vehicle.id, customer_id: customer1.id, started_at: now() });

    await expect(
      createOwnership({ vehicle_id: vehicle.id, customer_id: customer2.id, started_at: now() })
    ).rejects.toThrow(/unique constraint/i);
  });

  it('should allow new ownership after previous is ended', async () => {
    const vehicle = await createVehicle();
    const customer1 = await createCustomer();
    const customer2 = await createCustomer();

    const ownership1 = await createOwnership({ vehicle_id: vehicle.id, customer_id: customer1.id, started_at: daysAgo(10) });
    await endOwnership(ownership1.id, daysAgo(1));

    const ownership2 = await createOwnership({ vehicle_id: vehicle.id, customer_id: customer2.id, started_at: now() });

    expect(ownership2).toBeDefined();
  });
});
```

Questo template è referenziato dall'Appendice E (Testing Strategy) per le convenzioni test.

---

*Fine Appendice F — Business Logic Rules*
