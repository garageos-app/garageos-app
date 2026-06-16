# Appendice G — Error Codes Catalog

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Cataloga tutti gli error code restituiti dalle API di GarageOS.
>
> **Versione:** v1.0 — allineata a `GarageOS-Specifiche.md` v1.3
> **Ultimo aggiornamento:** 22 aprile 2026

---

## Scopo di questo documento

Questa appendice fornisce il **catalogo unificato degli errori** ritornati dalle API. Obiettivi:

1. **Coerenza**: stessi codici per stesse situazioni in tutto il sistema
2. **Localizzazione**: messaggi pronti per italiano (v1), predisposti per EN/DE (v2+)
3. **Debugging**: ogni error code è ricercabile nei log con codice univoco
4. **DX**: i client (web + mobile) possono gestire errori in modo affidabile tramite codice (non stringa)
5. **Audit**: errori critici vengono loggati in audit_logs

---

## Indice

1. [Convenzioni](#1-convenzioni)
2. [Struttura del payload errore](#2-struttura-del-payload-errore)
3. [Catalogo per categoria](#3-catalogo-per-categoria)
4. [Mapping a classi eccezione backend](#4-mapping-a-classi-eccezione-backend)
5. [Localizzazione](#5-localizzazione)
6. [Pattern per aggiungere nuovi error code](#6-pattern-per-aggiungere-nuovi-error-code)

---

## 1. Convenzioni

### 1.1 Struttura del codice

Ogni error code segue il pattern: `<area>.<sub_area>.<specifico>`

Esempi:
- `auth.login.invalid_credentials`
- `vehicle.creation.duplicate_vin`
- `intervention.modification.locked`
- `transfer.acceptance.expired`

**Regole di naming:**
- Solo lettere minuscole, underscore, punti
- Nomi descrittivi ma sintetici
- Gerarchia a 2-3 livelli (max)
- Niente numeri negli ID degli error code (vengono dati dallo HTTP status)

### 1.2 Status HTTP associato

Ogni error code ha uno status HTTP standardizzato:

| Range | Significato | Quando |
|---|---|---|
| `400` | Bad Request | Input malformato, validazione fallita |
| `401` | Unauthorized | Token mancante o scaduto |
| `403` | Forbidden | Autenticato ma non autorizzato |
| `404` | Not Found | Risorsa inesistente |
| `409` | Conflict | Conflitto stato (duplicato, stato incompatibile) |
| `410` | Gone | Risorsa espirata (es. invitation token scaduto) |
| `422` | Unprocessable Entity | Business rule violation |
| `429` | Too Many Requests | Rate limit |
| `500` | Internal Server Error | Errore inatteso backend |
| `502` | Bad Gateway | Servizio esterno fallito (SES, Expo Push) |
| `503` | Service Unavailable | Manutenzione o sovraccarico |

### 1.3 Severity

Ogni error code ha una severity per alerting interno:

- **`info`**: comportamento normale, non richiede intervento (es. credenziali sbagliate)
- **`warning`**: condizione anomala ma gestita (es. duplicate detection con conferma)
- **`error`**: errore applicativo da investigare (es. invariant violation)
- **`critical`**: errore infrastrutturale o sicurezza (es. data corruption, bypass tentato)

Gli errori `critical` generano alert Sentry + PagerDuty (v1.1+).

---

## 2. Struttura del payload errore

Tutti gli errori seguono **RFC 7807 Problem Details** con estensioni custom:

```json
{
  "type": "https://api.garageos.it/errors/vehicle.creation.duplicate_vin",
  "title": "Veicolo duplicato",
  "status": 409,
  "code": "vehicle.creation.duplicate_vin",
  "detail": "Esiste già un veicolo con VIN ZFA16900000512345",
  "instance": "/v1/vehicles",
  "request_id": "req_01HKXM9A...",
  "timestamp": "2026-04-22T15:32:05.123Z",
  "errors": [
    {
      "field": "vehicle.vin",
      "code": "duplicate",
      "message": "VIN già presente nel sistema"
    }
  ],
  "metadata": {
    "existing_vehicle_id": "01HKXN5..."
  }
}
```

### 2.1 Campi

| Campo | Obbligatorio | Descrizione |
|---|---|---|
| `type` | Sì | URL del tipo di errore (umano-leggibile su browser) |
| `title` | Sì | Titolo localizzato per l'utente |
| `status` | Sì | Status HTTP |
| `code` | Sì | **Error code univoco** (chiave per i client) |
| `detail` | Sì | Descrizione localizzata dettagliata |
| `instance` | Sì | URL della richiesta fallita |
| `request_id` | Sì | ID univoco richiesta per debug |
| `timestamp` | Sì | Momento dell'errore (ISO 8601 UTC) |
| `errors[]` | No | Lista errori di validazione multipli |
| `metadata` | No | Dati contestuali specifici dell'errore |

### 2.2 Quando usare `errors[]`

Solo per errori di validazione con più campi non validi:

```json
{
  "code": "validation.failed",
  "status": 400,
  "errors": [
    { "field": "vehicle.vin", "code": "invalid_format", "message": "VIN deve avere 17 caratteri" },
    { "field": "vehicle.year", "code": "out_of_range", "message": "Anno deve essere tra 1900 e 2027" },
    { "field": "customer.email", "code": "invalid_format", "message": "Email non valida" }
  ]
}
```

Per errori singoli business (es. duplicato) si usa `detail` + `metadata` senza `errors[]`.

### 2.3 Quando usare `metadata`

Per fornire dati utili al client per gestire l'errore:

- `existing_vehicle_id` quando si rileva duplicato
- `retry_after_seconds` quando si ha rate limit
- `transfer_id` quando si tenta di creare un transfer ma ne esiste già uno
- `expires_at` quando si tenta di usare un token valido ma scaduto

**Non includere mai** in metadata:
- Dati sensibili (password, token)
- PII di altri utenti
- Stack trace o dettagli interni

---

## 3. Catalogo per categoria

### 3.1 Errori generici

| Code | HTTP | Severity | Titolo | Quando |
|---|---|---|---|---|
| `generic.internal_error` | 500 | error | Errore interno | Errore non gestito |
| `generic.service_unavailable` | 503 | critical | Servizio non disponibile | Manutenzione o overload |
| `generic.rate_limit_exceeded` | 429 | warning | Troppe richieste | Rate limit hit |
| `generic.not_found` | 404 | info | Risorsa non trovata | Fallback quando non c'è code specifico |
| `validation.failed` | 400 | info | Dati non validi | Validazione Zod fallita |
| `validation.schema_mismatch` | 400 | warning | Schema richiesta non valido | JSON malformato |

### 3.2 Autenticazione & sessione

| Code | HTTP | Severity | Titolo | Quando |
|---|---|---|---|---|
| `auth.login.invalid_credentials` | 401 | info | Credenziali errate | Email/password sbagliati |
| `auth.login.account_locked` | 403 | warning | Account bloccato | Troppi tentativi falliti |
| `auth.login.account_inactive` | 403 | info | Account non attivo | User/customer `status=inactive` |
| `auth.login.email_not_verified` | 403 | info | Email non verificata | Account creato ma email non confermata |
| `auth.token.missing` | 401 | info | Token mancante | Header Authorization assente |
| `auth.token.invalid` | 401 | warning | Token non valido | JWT malformato o firma errata |
| `auth.token.expired` | 401 | info | Token scaduto | JWT con `exp` passato |
| `auth.token.revoked` | 401 | warning | Token revocato | Token in denylist (logout, security) |
| `auth.password_reset.invalid_token` | 400 | warning | Link non valido | Token reset scaduto o già usato |
| `auth.password.too_weak` | 400 | info | Password troppo debole | Policy password fallita |
| `auth.password_change.rate_limited` | 429 | warning | Troppi tentativi di cambio password | Troppi tentativi di cambio password da questo IP (5/15min) |
| `auth.password_reset.rate_limited` | 429 | warning | Troppi tentativi di reset password | Troppi tentativi di reset password da questo IP (5/15min) |
| `auth.signup.email_already_registered` | 409 | info | Email già registrata | Email duplicata in signup |
| `auth.signup.email_domain_blocked` | 403 | warning | Dominio email non consentito | Email blacklist |
| `auth.2fa.required` | 401 | info | 2FA richiesta | Account con 2FA attiva |
| `auth.2fa.invalid_code` | 401 | info | Codice 2FA errato | TOTP sbagliato |
| `auth.permission.denied` | 403 | warning | Permesso negato | Ruolo insufficiente |
| `auth.forbidden.wrong_pool` | 403 | warning | Pool autorizzazione errata | JWT da pool non autorizzato (es. clienti invece di officine) |
| `auth.forbidden.super_admin_required` | 403 | warning | Super admin richiesto | JWT role non è super_admin per operazione riservata |
| `auth.tenant.suspended` | 403 | warning | Tenant sospeso | Tenant `status=suspended` |
| `auth.cognito_unavailable` | 502 | error | Servizio di autenticazione temporaneamente non disponibile | POST /v1/users/invitations — Cognito `AdminGetUser` early-check fallisce (cross-tenant detection BR-213) |

### 3.3 Tenant & organizzazione

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `tenant.not_found` | 404 | info | Tenant non trovato | ID inesistente | |
| `tenants.me.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/tenants/me con body vuoto o senza campi edibili | F-OFF-007 |
| `tenants.me.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/tenants/me con chiave non in schema (es. vatNumber, status, plan) | F-OFF-007 |
| `me.profile.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/me/profile con body vuoto o senza campi edibili | F-CLI-004 |
| `me.profile.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/me/profile con chiave non in schema (es. email, status) | F-CLI-004 |
| `me.notification-preferences.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/me/notification-preferences con body vuoto o senza preferenze edibili | F-CLI-005 |
| `me.notification-preferences.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/me/notification-preferences con chiave fuori schema (transfer_invitation, push, dispute_response) o valore non booleano | F-CLI-005, BR-260 |
| `me.push-token.not_found` | 404 | info | Token push non trovato | DELETE /v1/me/push-tokens/:id con id inesistente o di un altro cliente (RLS) | F-CLI-302 (BR-254) |
| `me.push-token.register.invalid_token` | 422 | info | Token push non valido | POST /v1/me/push-tokens con expoPushToken malformato (atteso ExpoPushToken[...]) | F-CLI-302 (BR-254) |
| `me.push-token.register.unknown_field` | 422 | info | Campo non riconosciuto | POST /v1/me/push-tokens con chiave fuori schema | F-CLI-302 |
| `me.intervention.not_found` | 404 | info | Intervento non trovato o non più di proprietà del cliente | GET /v1/me/interventions/:id — intervento inesistente o veicolo non più di proprietà del cliente (gate app-layer) | F-CLI-206 |
| `me.vehicle.claim.code_not_found` | 404 | info | Codice non trovato | POST /v1/me/vehicles/claim con garageCode inesistente | F-CLI-101 (BR-042) |
| `me.vehicle.claim.owned_by_other` | 409 | info | Veicolo di un altro cliente | POST /v1/me/vehicles/claim su veicolo con ownership attiva di altro cliente (usare passaggio di proprietà) | F-CLI-101 (BR-042) |
| `me.vehicle.claim.pending` | 422 | info | Veicolo non certificato | POST /v1/me/vehicles/claim su veicolo pending | F-CLI-101 (BR-042) |
| `me.vehicle.claim.archived` | 422 | info | Veicolo archiviato | POST /v1/me/vehicles/claim su veicolo archived | F-CLI-101 (BR-042) |
| `tenant.vat_number_duplicate` | 409 | info | P.IVA già registrata | VAT duplicata in creazione | |
| `tenant.vat_number_invalid` | 400 | info | P.IVA non valida | Checksum P.IVA IT fallito | |
| `tenant.billing.past_due` | 402 | warning | Pagamento in sospeso | Solo v1.1+ | |
| `location.not_found` | 404 | info | Location non trovata | | |
| `location.not_in_tenant` | 422 | warning | Location non appartiene al tenant | Tentativo cross-tenant | |
| `tenants.me.locations.not_found` | 404 | info | Sede non trovata | PATCH/DELETE /v1/tenants/me/locations/:id con id non del tenant o gia disattivato | F-OFF-003 |
| `tenants.me.locations.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH location con body vuoto | F-OFF-003 |
| `tenants.me.locations.update.unknown_field` | 422 | info | Campo non riconosciuto | POST/PATCH location con chiave non in schema | F-OFF-003 |
| `tenants.me.locations.cannot_unset_primary` | 422 | info | Non si puo togliere la sede primaria | PATCH location con isPrimary:false | F-OFF-003 (BR-201) |
| `tenants.me.locations.cannot_delete_primary` | 422 | warning | Non si puo disattivare la sede primaria | DELETE sulla sede primaria | F-OFF-003 (BR-201) |
| `tenants.me.locations.has_active_users` | 422 | warning | Sede con meccanici attivi | DELETE sede con utenti attivi assegnati | F-OFF-003 (BR-204) |
| `location.cannot_remove_primary` | 422 | warning | Non puoi rimuovere la sede principale | Senza designarne un'altra | BR-201 |
| `location.cannot_disable_last` | 422 | warning | Impossibile disattivare l'ultima sede attiva | | |
| `user.not_found` | 404 | info | Utente non trovato | GET, PATCH, DELETE /v1/users/:id — target mancante o cross-tenant | F-OFF-004 |
| `user.cannot_delete_self_via_admin` | 422 | warning | Non puoi rimuovere te stesso da qui | DELETE /v1/users/:id — actor == target | F-OFF-004 |
| `user.last_super_admin` | 409 | error | Impossibile rimuovere/declassare l'ultimo amministratore | DELETE o PATCH /v1/users/:id che lascerebbe il tenant senza super_admin attivi | F-OFF-004, BR-203 |
| `user.location_required_for_mechanic` | 422 | warning | Un meccanico deve essere assegnato a una sede | POST /v1/users/invitations o PATCH /v1/users/:id con role=mechanic e locationId null | F-OFF-004, BR-204 |
| `user.location_invalid` | 422 | warning | Sede non valida o inattiva | PATCH /v1/users/:id con locationId non appartenente al tenant o status!=active | F-OFF-004 |
| `user.invitation.not_found` | 404 | info | Invito non trovato | Token non esistente, tipo errato, scaduto o già consumato (anti-enum: tutti i casi restituiscono 404) | F-OFF-004 |
| `user.invitation.email_already_active` | 409 | info | Account con questa email già attivo | POST /v1/users/invitations o POST /v1/invitations/:token/accept — utente già esistente nel tenant | F-OFF-004 |
| `user.invitation.duplicate_pending` | 409 | info | Esiste già un invito pendente per questa email | POST /v1/users/invitations — violazione indice parziale uq_invitations_pending_internal (BR-206) | F-OFF-004, BR-206 |
| `user.invitation.location_invalid` | 422 | warning | Sede non valida o inattiva | POST /v1/users/invitations — locationId non appartiene al tenant o status!=active | F-OFF-004 |
| `user.invitation.accept_password_policy` | 422 | warning | Password non conforme ai requisiti | POST /v1/invitations/:token/accept — Cognito rifiuta la password per policy | F-OFF-004 |
| `user.invitation.cognito_unavailable` | 502 | error | Servizio di autenticazione temporaneamente non disponibile | POST /v1/invitations/:token/accept — Cognito AdminCreateUser o AdminSetUserPassword fallisce | F-OFF-004 |
| `user.invitation.already_accepted` | 410 | info | Invito già accettato o revocato | DELETE /v1/users/invitations/:id su invito già tombstonato (acceptedAt != null) | F-OFF-004 |
| `user.invitation.expired` | 410 | info | Invito scaduto | Token invitation > 7 giorni (v1.0 spec — anti-enum: collapsed to not_found in public endpoints) | |
| `user.invitation.email_mismatch` | 403 | warning | Email non corrisponde all'invito | Sign-up con email diversa | |
| `user.already_active` | 422 | info | Utente già attivo | POST /v1/users/:id/reactivate su utente non soft-deleted (race / replay) | F-OFF-004, BR-212 |
| `user.invitation.email_in_other_tenant` | 409 | warning | Questa email risulta già registrata in un'altra officina. Contatta il supporto. | POST /v1/users/invitations — Cognito `AdminGetUser` hit + nessun User row nel tenant chiamante | F-OFF-004, BR-213 |
| `user.invitation.email_soft_deleted_in_tenant` | 409 | info | Questa email appartiene a un utente disattivato. Riattivalo da Impostazioni → Utenti. | POST /v1/users/invitations — re-invite same email in same tenant dove l'utente è soft-deleted | F-OFF-004, BR-212 |
| `users.me.avatar.invalid_mime` | 422 | info | Tipo file non valido — richiesto JPEG | POST /v1/users/me/avatar/confirm — HeadObject contentType ≠ image/jpeg | F-OFF-007 |
| `users.me.avatar.s3_unavailable` | 502 | error | Servizio storage temporaneamente non disponibile | POST /v1/users/me/avatar/upload-url o /confirm — S3 error | F-OFF-007 |
| `users.me.avatar.upload_not_found` | 422 | info | File non trovato su S3 — upload non atterrato o scaduto | POST /v1/users/me/avatar/confirm — HeadObject NoSuchKey | F-OFF-007 |
| `users.me.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/users/me con body vuoto o senza campi edibili | F-OFF-007 |
| `users.me.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/users/me con chiave non in schema (es. email, role, tenantId) | F-OFF-007 |
| ~~`user.cannot_remove_last_super_admin`~~ | — | — | *Stale spec code — non implementato* | Sostituito da `user.last_super_admin` in F-OFF-004 | BR-203 |
| ~~`user.role_change_would_orphan_tenant`~~ | — | — | *Stale spec code — non implementato* | Sostituito da `user.last_super_admin` in F-OFF-004 | BR-203 |

### 3.4 Customer

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `customer.not_found` | 404 | info | Cliente non trovato | | |
| `customer.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH /v1/customers/:id con body vuoto | F-OFF-204 |
| `customer.update.unknown_field` | 422 | info | Campo non modificabile | PATCH /v1/customers/:id con chiave non in schema (es. email, cognitoSub) | F-OFF-204, BR-151 |
| `customer.email_duplicate` | 409 | info | Cliente con questa email già esistente | | BR-220 |
| `customer.tax_code_invalid` | 400 | info | Codice fiscale non valido | Checksum CF fallito | |
| `customer.business_data_missing` | 400 | info | Dati azienda richiesti | is_business=true ma business_name/vat_number assenti | BR-223 |
| `customer.pii_not_accessible` | 403 | info | Dati personali non accessibili | Tenant senza customer_tenant_relation | BR-151 |
| `customer.deletion.active_transfers` | 422 | warning | Impossibile cancellare: transfer attivi | Account delete con transfer pending | |

### 3.5 Veicoli

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `vehicle.not_found` | 404 | info | Veicolo non trovato | | |
| `vehicle.garage_code.not_found` | 404 | info | Codice GarageOS non trovato | Claim con codice inesistente | |
| `vehicle.garage_code.invalid_format` | 400 | info | Formato codice non valido | Fallisce regex | BR-020 |
| `vehicle.creation.duplicate_vin` | 409 | warning | VIN già presente | VIN esistente certified | BR-001 |
| `vehicle.creation.duplicate_plate_warning` | 409 | warning | Targa identica su altro veicolo | Conferma richiesta con force | BR-002 |
| `vehicle.creation.vin_invalid_format` | 400 | info | VIN formato non valido | 17 caratteri mancanti | BR-001 |
| `vehicle.creation.invalid_vin_checksum` | 400 | warning | VIN checksum non valido | Può essere forzato con force_nonstandard_vin (solo officina; la pre-registrazione cliente F-CLI-104 non ha bypass) | BR-001 |
| `vehicle.creation.plate_invalid_format` | 400 | info | Formato targa non valido | | |
| `vehicle.creation.year_out_of_range` | 400 | info | Anno fuori range | <1900 o >current+1 | BR-007 |
| `vehicle.modification.vin_immutable` | 422 | error | VIN non modificabile | Tentativo di modifica su certified | BR-005 |
| `vehicle.modification.certified_required` | 422 | warning | Operazione richiede veicolo certificato | | |
| `vehicle.modification.archived` | 422 | info | Veicolo archiviato, non modificabile | | BR-008 |
| `vehicle.certification.not_pending` | 422 | warning | Veicolo non in stato pending | Certify su veicolo già certified | BR-004 |
| `vehicle.certification.libretto_required` | 422 | info | Dichiarazione visione libretto richiesta | Checkbox non selezionata | BR-004 |
| `vehicle.pending.duplicate_vin_certified` | 409 | warning | VIN già certificato | Pre-registrazione utente con VIN esistente | BR-001 |
| `vehicle.claim.already_owned_by_you` | 200 | info | Già proprietario (idempotente, OK) | Claim idempotente | BR-042 |
| `vehicle.claim.already_owned_by_other` | 409 | warning | Veicolo già assegnato ad altro utente | Claim con ownership attiva altrui | BR-042 |
| `vehicle.claim.pending_not_claimable` | 422 | info | Veicolo non certificato | Claim di pending | BR-042 |
| `vehicle.claim.archived` | 422 | info | Veicolo archiviato | | BR-042 |
| `vehicle.access.forbidden` | 403 | warning | Accesso al veicolo non consentito | Customer non proprietario | |
| `vehicle.archived` | 409 | info | Veicolo archiviato, operazione non disponibile | Tag PDF, transfer e altri flussi su veicoli archiviati | BR-026 |
| `vehicle.not_certified` | 409 | info | Veicolo non certificato, operazione non disponibile | Tag PDF su veicolo `pending` | BR-026 |

### 3.6 Interventi

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `intervention.not_found` | 404 | info | Intervento non trovato | | |
| `intervention.creation.immutable_field` | 422 | error | Campo non modificabile | Tentativo modifica campo immutabile | BR-061 |
| `intervention.creation.date_future` | 400 | info | Data intervento futura | | BR-069 |
| `intervention.creation.date_before_registration` | 400 | warning | Data precedente immatricolazione | | BR-070 |
| `intervention.creation.odometer_decrease_warning` | 409 | warning | Km inferiori ad intervento precedente | Richiede force_km_decrease | BR-068 |
| `intervention.creation.parts_invalid` | 400 | info | Lista pezzi non valida | Struttura parts_replaced malformata | BR-071 |
| `intervention.creation.type_not_found` | 404 | info | Tipo intervento non trovato | | |
| `intervention.modification.locked` | 422 | info | Intervento non più modificabile liberamente | Wiki locked | BR-062 |
| `intervention.modification.revision_reason_required` | 400 | info | Motivazione modifica obbligatoria | Modifica post-lock senza reason | BR-064 |
| `intervention.modification.cancelled` | 422 | info | Intervento cancellato: non modificabile | BR-130 — modifiche bloccate dopo annullamento | BR-130 |
| `intervention.modification.disputed` | 422 | info | Intervento contestato: non modificabile | BR-128 — l'officina deve rispondere alla dispute (F-OFF-602) prima di poter modificare | BR-128 |
| `intervention.cancellation.already_cancelled` | 409 | info | Intervento già annullato | | BR-066 |
| `intervention.cancellation.reason_too_short` | 400 | info | Motivazione troppo breve | <20 caratteri | BR-066 |
| `intervention.cancellation.permission_denied` | 403 | warning | Solo super_admin può annullare | | BR-066 |
| `intervention.dispute.already_exists` | 409 | info | Contestazione già aperta | Una per customer per intervention | BR-122 |
| `intervention.dispute.not_owner` | 403 | warning | Solo il proprietario può contestare | | BR-120 |
| `intervention.dispute.description_too_short` | 400 | info | Descrizione contestazione troppo breve | <20 caratteri | BR-124 |
| `intervention.dispute.attachment_not_found` | 422 | warning | attachmentId non valido o non uploadato dal caller | Verifica che gli id siano stati uploadati con owner_type=intervention_dispute, owner_id=intervention.id, dal pool corrente |  |
| `intervention.dispute.attachment_not_processed` | 422 | warning | attachmentId esiste ma `processed=false` | Chiama `POST /v1/attachments/<id>/confirm` prima di passarlo nella dispute |  |
| `intervention.dispute.attachment_already_claimed` | 409 | warning | attachmentId già linked a un'altra dispute | Ottieni un nuovo upload-url e riuploada |  |
| `intervention.dispute.response.not_your_intervention` | 403 | warning | Contestazione di altro tenant (~~reservato — sostituito da RLS-as-404 in v1~~) | | |
| `intervention.dispute.response.description_too_short` | 400 | info | Risposta troppo breve | <20 caratteri | BR-129 |
| `intervention.dispute.response.permission_denied` | 403 | warning | Ruolo non autorizzato a rispondere | Ruolo fuori da {super_admin, mechanic} | BR-129 |
| `intervention.dispute.response.no_active_dispute` | 409 | info | Nessuna contestazione `open` da rispondere | Omitted dispute_id senza target oppure dispute_id su stato non `open` | BR-129 |
| `intervention.dispute.response.attachments_require_dispute_id` | 422 | warning | Officina fanout (no dispute_id) + attachmentIds non empty | Specifica `dispute_id` nella request body |  |
| `intervention.revisions.not_owner` | 403 | warning | Solo il proprietario può consultare lo storico modifiche | Cliente non proprietario attivo del veicolo dell'intervento | BR-064 |

### 3.7 Interventi privati

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `private_intervention.date_future` | 422 | warning | Data intervento futura | Data caricata > today (UTC midnight) | BR-069 mirror |
| `private_intervention.not_found` | 404 | info | Intervento privato non trovato | | |
| `private_intervention.not_owner` | 403 | warning | Non sei il proprietario | | BR-080 |
| `private_intervention.rate_limit` | 429 | warning | Limite interventi privati superato | >50/giorno | BR-085 |
| `private_intervention.vehicle_not_owned` | 422 | warning | Veicolo non nella tua lista | | |

### 3.8 Trasferimenti di proprietà

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `transfer.not_found` | 404 | info | Trasferimento non trovato | | |
| `transfer.creation.not_current_owner` | 403 | warning | Non sei il proprietario attuale | | F-CLI-401 |
| `transfer.creation.already_pending` | 409 | warning | Transfer già attivo per questo veicolo | | BR-047, F-CLI-401 |
| `transfer.creation.vehicle_not_certified` | 422 | info | Impossibile trasferire veicolo pending | | BR-046, F-CLI-401 |
| `transfer.creation.vehicle_not_found` | 404 | info | Veicolo non trovato | POST /v1/me/transfers con vehicleId inesistente | F-CLI-401 |
| `transfer.acceptance.expired` | 410 | info | Trasferimento scaduto | expires_at passato | |
| `transfer.acceptance.already_completed` | 409 | info | Trasferimento già completato | | |
| `transfer.acceptance.not_pending_recipient` | 422 | warning | Stato non valido per accettazione | | |
| `transfer.acceptance.invited_email_mismatch` | 403 | warning | Email non corrisponde all'invito | | |
| `transfer.acceptance.self_not_allowed` | 403 | warning | Non puoi accettare un trasferimento avviato da te | accept del proprio transfer | F-CLI-401, BR-043 |
| `transfer.confirmation.not_pending_seller` | 422 | warning | Stato non valido per conferma cedente | | |
| `transfer.confirmation.not_from_customer` | 403 | warning | Non sei il cedente di questo transfer | | |
| `transfer.confirmation.expired` | 410 | info | Trasferimento scaduto | expires_at passato dopo accettazione | F-CLI-403, BR-043 |
| `transfer.confirmation.ownership_conflict` | 409 | warning | Stato proprieta veicolo cambiato | concorrenza sullo swap | F-CLI-403 |
| `transfer.claim_without_seller.libretto_required` | 400 | info | Libretto di circolazione obbligatorio | | BR-044 |
| `transfer.claim_without_seller.ocr_mismatch` | 422 | warning | Dati libretto non corrispondono | Review manuale | BR-044 |
| `transfer.rejection.not_permitted` | 403 | warning | Non puoi rifiutare questo transfer | | |
| `transfer.rejection.not_pending` | 409 | info | Trasferimento gia in stato terminale | reject di un transfer non attivo | F-CLI-403, BR-048 |
| `vehicle.transfer.pending_not_transferable` | 422 | info | Veicolo non certificato non trasferibile | F-OFF-110 | BR-046, BR-049 |
| `vehicle.transfer.archived` | 422 | info | Veicolo archiviato non trasferibile | F-OFF-110 | BR-049 |
| `vehicle.transfer.no_active_ownership` | 422 | info | Veicolo senza proprietario attivo | F-OFF-110 | BR-049 |
| `vehicle.transfer.active_transfer_exists` | 409 | warning | Trasferimento già in corso per questo veicolo | F-OFF-110 | BR-047, BR-049 |
| `vehicle.transfer.same_owner` | 409 | warning | Il cessionario coincide con il proprietario attuale | F-OFF-110 | BR-049 |
| `vehicle.transfer.recipient_not_found` | 422 | info | Cessionario non trovato | F-OFF-110 `kind=existing` | BR-049 |
| `vehicle.transfer.role_denied` | 403 | warning | Ruolo non autorizzato per il trasferimento | F-OFF-110 caller non super_admin/mechanic | BR-049 |
| `vehicle.transfer.document_invalid` | 422 | info | Il documento del libretto fornito non è valido: chiave malformata, file inesistente su S3, o dimensione/formato non conforme | F-OFF-110 PR-2 `documentS3Key` non valido | BR-049 |
| `vehicle.transfer.document_s3_unavailable` | 502 | error | Servizio di storage non disponibile durante la firma o la verifica del caricamento del libretto | F-OFF-110 PR-2 S3 irraggiungibile | BR-049 |

### 3.9 Scadenze

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `deadline.not_found` | 404 | info | Scadenza non trovata | | |
| `deadline.creation.missing_criterion` | 400 | info | Almeno un criterio richiesto | Né data né km | BR-100 |
| `deadline.creation.duplicate_warning` | 409 | warning | Scadenza dello stesso tipo già aperta | Richiede force_duplicate | BR-109 |
| `deadline.completion.already_completed` | 409 | info | Scadenza già completata | | |
| `deadline.completion.intervention_mismatch` | 422 | warning | Intervento non corrisponde al tipo scadenza | | BR-067 |
| `deadline.modification.permission_denied` | 403 | warning | Solo chi l'ha creata può modificarla | | |
| `deadline.recurring.config_invalid` | 400 | info | Config ricorrenza incompleta | is_recurring=true senza months o km | |

### 3.10 Allegati

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `attachment.not_found` | 404 | info | Allegato non trovato | | |
| `attachment.upload.too_large` | 400 | info | File troppo grande | >10 MB | BR-180 |
| `attachment.upload.mime_not_allowed` | 400 | info | Formato non consentito | Formato non in whitelist | BR-180 |
| `attachment.upload.too_many` | 409 | info | Limite allegati raggiunto | >10 per intervention | BR-180 |
| `attachment.upload.url_expired` | 410 | info | URL di upload scaduto | Presigned URL >15min | |
| `attachment.upload.confirmation_mismatch` | 422 | warning | Conferma upload non corrisponde | Size/hash mismatch | |
| `attachment.download.permission_denied` | 403 | warning | Non autorizzato a scaricare | | BR-184 |
| `attachment.deletion.locked` | 422 | info | Allegato bloccato, intervento fuori finestra wiki | | BR-183 |

### 3.11 Notifiche & push

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `notification.push_token.invalid` | 400 | info | Push token non valido | Token Expo non riconosciuto | |
| `notification.push_token.already_registered` | 409 | info | Token già registrato (idempotente) | | BR-254 |
| `notification.rate_limit` | 429 | warning | Troppe notifiche per customer | >5 email/giorno | BR-251 |

### 3.12 Contestazioni

*Già coperte in §3.6 (intervention.dispute.*).*

### 3.13 Admin & sistema

| Code | HTTP | Severity | Titolo | Quando |
|---|---|---|---|---|
| `admin.permission.denied` | 403 | critical | Azione riservata ad admin | |
| `admin.impersonation.target_not_found` | 404 | info | Tenant da impersonare non trovato | |
| `admin.impersonation.not_allowed` | 403 | critical | Impersonation non consentita | Target è admin |
| `system.database.connection_failed` | 503 | critical | Database non raggiungibile | |
| `system.email.send_failed` | 502 | error | Invio email fallito | SES error |
| `system.push.send_failed` | 502 | error | Invio push fallito | Expo Push error |
| `system.s3.upload_failed` | 502 | error | Upload S3 fallito | |
| `system.scheduler.schedule_failed` | 502 | error | Creazione schedule EventBridge fallita | |

### 3.14 GDPR & privacy

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `gdpr.deletion.active_data` | 422 | warning | Dati attivi impediscono cancellazione | Transfer pending, dispute open | BR-158 |
| `gdpr.export.in_progress` | 409 | info | Export già in corso | |
| `gdpr.export.not_ready` | 404 | info | Export non ancora pronto | Job async in elaborazione |

### 3.15 Scadenze personali del cliente (F-CLI-306)

| Code | HTTP | Severity | Titolo | Quando | BR |
|---|---|---|---|---|---|
| `personal_deadline.vehicle_not_owned` | 403 | warning | Non sei il proprietario di questo veicolo. | POST /v1/me/personal-deadlines — `vehicleId` inesistente o senza ownership attiva del caller | F-CLI-306, BR-290 |
| `personal_deadline.not_found` | 404 | info | Scadenza non trovata. | GET/PATCH/DELETE/POST .../complete con `id` inesistente o di un altro cliente (app-layer scoping) | F-CLI-306 |
| `personal_deadline.custom_label_required` | 422 | info | Specifica un'etichetta per la categoria 'Altro'. | POST o PATCH con `category='other'` e `customLabel` assente o vuoto | F-CLI-306, BR-294 |
| `personal_deadline.update.empty_body` | 422 | info | Specifica almeno un campo da aggiornare. | PATCH /v1/me/personal-deadlines/:id con body vuoto o senza campi edibili | F-CLI-306 |
| `personal_deadline.not_open` | 409 | warning | La scadenza è già completata o annullata. | POST /v1/me/personal-deadlines/:id/complete su scadenza in stato terminale (`completed`/`cancelled`); `open` e `overdue` sono completabili (BR-298) | F-CLI-306 |

### 3.16 Auth — Signup

### `auth.signup.email_already_active` — HTTP 409
Un account customer con questa email è già registrato e ha un Cognito user collegato. Il client deve mostrare "Effettua il login" (link a flow Cognito InitiateAuth USER_SRP_AUTH).

### `auth.signup.tenant_signup_not_supported` — HTTP 422
`type=tenant_admin` non è ancora supportato (v1: solo customer). Verrà supportato in PR dedicata.

### `auth.signup.password_policy_violation` — HTTP 422
La password fornita non soddisfa la policy del Cognito user pool clienti (min 8 caratteri, almeno una minuscola, almeno una cifra). Il client deve evidenziare il campo password.

### `auth.signup.cognito_unavailable` — HTTP 502
Cognito non risponde (throttle / outage). Il client deve mostrare un messaggio "riprova tra qualche istante". Auto-retry con backoff è opzionale (idempotenza non garantita: il signup potrebbe aver creato il Customer row e fallito al passo Cognito).

### `auth.signup.rate_limited` — HTTP 429
Troppi tentativi di registrazione dallo stesso IP (5 richieste in 15 minuti). Il client deve rispettare l'header `Retry-After` o il campo `retry_after_seconds` nel body.

---

### 3.17 Attachments (F-OFF-305)

| Codice | HTTP | Trigger | Suggerimento client |
| --- | --- | --- | --- |
| `attachment.upload.intervention_not_found` | 404 | `owner_id` non corrisponde a un intervention del tenant del caller (RLS scoping) | Verifica che l'intervention esista e appartenga al tenant corrente; non chiamare upload-url su intervention di altri tenant. |
| `attachment.upload.mime_type_not_allowed` | 422 (oggi: 400 VALIDATION_ERROR) | `mime_type` fuori whitelist (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`) | Fai upload solo dei tipi supportati. Per altri formati (es. video), scegli un'alternativa o richiedi extension whitelist. |
| `attachment.upload.size_too_large` | 422 (oggi: 400 VALIDATION_ERROR) | `size_bytes > 26_214_400` (25 MB) | Comprimi o splitta il file. Limit attuale 25 MB per attachment. |
| `attachment.upload.invalid_file_name` | 422 (oggi: 400 VALIDATION_ERROR) | `file_name` vuoto, troppo lungo (>255), o contiene null/control bytes | Sanitizza il nome lato client prima del POST. |
| `attachment.upload.s3_unavailable` | 502 | AWS SDK signing fail (errori temporanei AWS) | Retry con exponential backoff. Se persistente, errore lato server. |
| `attachment.upload.intervention_dispute_not_owner` | 403 | Customer-pool non è current owner del veicolo dell'intervention | Solo current owner può allegare prove a una dispute |
| `attachment.upload.intervention_dispute_role_denied` | 403 | Officina-pool con role non in `[super_admin, mechanic]` | Verifica il ruolo dell'utente |
| `attachment.upload.no_open_dispute` | 422 | Officina upload con `owner_type=intervention_dispute` ma nessuna dispute `open` esiste | Crea/verifica la dispute prima |
| `attachment.upload.officina_only` | 403 | Clienti-pool tenta `owner_type=intervention` (officina-only) | Usa officina-pool token |
| `attachment.upload.officina_pool_not_allowed_for_private` | 403 | Officina pool tenta upload su `owner_type=private_intervention` (F-OFF-305 reciprocal: clienti-only) | Solo clienti-pool può caricare allegati su interventi privati customer-side |
| `attachment.upload.private_intervention_not_found` | 404 | Intervento privato target non esistente, soft-deleted, o appartenente a un altro customer (F-OFF-305 reciprocal) | Verifica che il private intervention esista e appartenga al customer corrente |
| `attachment.confirm.not_found` | 404 | Attachment id non esiste o appartiene ad altro tenant | Verifica l'id; richiamare upload-url se l'attachment è stato pulito (deferred lifecycle). |
| `attachment.confirm.not_uploader` | 403 | Caller diverso dall'uploader originario | Solo chi ha chiamato upload-url può confirmare. Per re-upload, ottieni un nuovo upload-url. |
| `attachment.confirm.upload_not_found` | 422 | S3 HeadObject ritorna NoSuchKey o 404 | L'upload non è atterrato su S3 (URL expirato o PUT mai effettuato). Re-richiedi upload-url e ritenta. |
| `attachment.confirm.metadata_mismatch` | 422 | ContentLength o ContentType S3 non matcha quanto dichiarato in upload-url | Re-fai upload-url con i metadata corretti del file uploadato. Defense vs file-swap post-presign. |
| `attachment.confirm.s3_unavailable` | 502 | AWS SDK HeadObject error generico | Retry con backoff. |

**Nota validation Zod**: gli errori di validation (mime fuori whitelist, size > 25MB, file_name invalido) attualmente ritornano `400 VALIDATION_ERROR` (RFC 7807 standard via `@fastify/sensible`) — il code dot-separated specifico (`attachment.upload.mime_type_not_allowed`) è documentato qui per riferimento ma il client riceve `code: VALIDATION_ERROR` con `details` array. In una future iteration, il dot-separated code può essere mappato esplicitamente per granularità.

---

### 3.18 Tag PDF veicolo (F-OFF-104)

#### `vehicle.archived`

**HTTP 409.** Operazione non disponibile perché il veicolo è in stato `archived`. Tag PDF, transfer, e altri flussi business-logic non accettano veicoli archiviati.

#### `vehicle.not_certified`

**HTTP 409.** Operazione richiede veicolo `certified`, ma è in stato `pending`. Il tag PDF (BR-026) è disponibile solo post-certificazione.

#### `vehicle_tag.s3_head_failed`

**HTTP 500.** S3 HeadObject ha fallito per ragioni diverse da NoSuchKey (IAM denial, network, throttle). Server log contiene dettaglio. Cliente riceve `internal_error` generico.

#### `vehicle_tag.s3_upload_failed`

**HTTP 500.** S3 PutObject ha fallito dopo render PDF success. PDF buffer perso; next retry rifa render + upload (idempotente).

#### `vehicle_tag.render_failed`

**HTTP 500.** `pdf-lib` o `qrcode` ha lanciato durante render. Verificare deps e input.

#### `vehicle_tag.audit_insert_failed`

**HTTP 500.** INSERT su `vehicle_tag_prints` ha fallito (DB down, FK violation, RLS deny). Fail-closed: response non inviata. S3 PUT è già successo idempotentemente, next retry trova cache-hit + INSERT retry.

#### `vehicle_tag.never_printed`

**HTTP 409.** Tentativo di ristampa tag (`POST /v1/vehicles/:id/tag-reprint`) su veicolo senza audit precedenti. Il primo download deve passare per il flow PR1 (`GET /v1/vehicles/:id/tag`). Stato non raggiungibile via UI normale (gating frontend via `tag_first_printed_at`); difensivo per chiamate API dirette.

---

## 4. Mapping a classi eccezione backend

### 4.1 Gerarchia eccezioni

Nel codice backend, gli errori vengono lanciati come eccezioni TypeScript. La gerarchia:

```typescript
// packages/api/src/errors/index.ts

export abstract class ApiError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly severity: 'info' | 'warning' | 'error' | 'critical' = 'info';
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.metadata = metadata;
  }
}

// Subclassi base per HTTP status
export class ValidationError extends ApiError {
  readonly httpStatus = 400;
  readonly code = 'validation.failed';
  readonly errors: FieldError[];

  constructor(errors: FieldError[]) {
    super('Validation failed');
    this.errors = errors;
  }
}

export class AuthenticationError extends ApiError {
  readonly httpStatus = 401;
  readonly code: string = 'auth.token.invalid';
}

export class AuthorizationError extends ApiError {
  readonly httpStatus = 403;
  readonly code: string = 'auth.permission.denied';
  readonly severity = 'warning' as const;
}

export class NotFoundError extends ApiError {
  readonly httpStatus = 404;
  readonly code: string;

  constructor(resourceType: string, id?: string) {
    super(`${resourceType} not found${id ? `: ${id}` : ''}`);
    this.code = `${resourceType}.not_found`;
  }
}

export class ConflictError extends ApiError {
  readonly httpStatus = 409;
  readonly code: string;

  constructor(code: string, message: string, metadata?: Record<string, unknown>) {
    super(message, metadata);
    this.code = code;
  }
}

export class BusinessError extends ApiError {
  readonly httpStatus = 422;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' = 'warning';

  constructor(code: string, message: string, metadata?: Record<string, unknown>, severity?: 'info' | 'warning' | 'error') {
    super(message, metadata);
    this.code = code;
    if (severity) this.severity = severity;
  }
}

export class RateLimitError extends ApiError {
  readonly httpStatus = 429;
  readonly code: string;
  readonly severity = 'warning' as const;

  constructor(code: string, retryAfterSeconds: number) {
    super('Rate limit exceeded', { retry_after_seconds: retryAfterSeconds });
    this.code = code;
  }
}
```

### 4.2 Subclassi specifiche per business rules critiche

Per le BR più usate, conviene avere classi dedicate per migliorare la leggibilità del codice:

```typescript
// packages/api/src/errors/vehicle.ts

export class DuplicateVinError extends ConflictError {
  constructor(vin: string, existingVehicleId: string) {
    super(
      'vehicle.creation.duplicate_vin',
      `Veicolo con VIN ${vin} già esistente`,
      { existing_vehicle_id: existingVehicleId, vin }
    );
  }
}

export class VehicleAlreadyOwnedError extends ConflictError {
  constructor(vehicleId: string) {
    super(
      'vehicle.claim.already_owned_by_other',
      'Veicolo già assegnato ad altro proprietario',
      { vehicle_id: vehicleId }
    );
  }
}

export class VinImmutableError extends BusinessError {
  constructor(vehicleId: string) {
    super(
      'vehicle.modification.vin_immutable',
      'VIN non modificabile su veicolo certificato',
      { vehicle_id: vehicleId },
      'error'
    );
  }
}

export class OdometerDecreaseWarning extends ConflictError {
  constructor(lastKm: number, newKm: number) {
    super(
      'intervention.creation.odometer_decrease_warning',
      `Km (${newKm}) inferiori all'ultimo intervento (${lastKm}). Conferma richiesta.`,
      { last_km: lastKm, new_km: newKm, force_param: 'forceKmDecrease' }
    );
  }
}
```

### 4.3 Error handler Fastify globale

```typescript
// packages/api/src/plugins/error-handler.ts
import { FastifyPluginAsync } from 'fastify';
import { ApiError } from '../errors';
import { ZodError } from 'zod';

const errorHandler: FastifyPluginAsync = async (app) => {
  app.setErrorHandler(async (error, request, reply) => {
    const requestId = request.id;
    const instance = request.url;
    const timestamp = new Date().toISOString();

    // Zod validation errors
    if (error instanceof ZodError) {
      const apiError = new ValidationError(
        error.errors.map((e) => ({
          field: e.path.join('.'),
          code: e.code,
          message: e.message,
        }))
      );
      return sendApiError(reply, apiError, { request_id: requestId, instance, timestamp });
    }

    // Our custom ApiError
    if (error instanceof ApiError) {
      // Log based on severity
      if (error.severity === 'critical') {
        request.log.error({ err: error, metadata: error.metadata }, 'Critical API error');
        // Report to Sentry
      } else if (error.severity === 'error') {
        request.log.error({ err: error }, 'API error');
      } else {
        request.log.info({ code: error.code }, 'Handled API error');
      }

      return sendApiError(reply, error, { request_id: requestId, instance, timestamp });
    }

    // Prisma errors (specifici)
    if (error.code === 'P2002') {
      // Unique constraint violation
      const apiError = new ConflictError(
        'generic.duplicate',
        'Record duplicato',
        { target: (error as any).meta?.target }
      );
      return sendApiError(reply, apiError, { request_id: requestId, instance, timestamp });
    }

    // Errore non gestito → 500
    request.log.error({ err: error }, 'Unhandled error');
    const internalError = new InternalServerError();
    return sendApiError(reply, internalError, { request_id: requestId, instance, timestamp });
  });
};

function sendApiError(reply: FastifyReply, error: ApiError, ctx: { request_id: string; instance: string; timestamp: string }) {
  const payload = {
    type: `https://api.garageos.it/errors/${error.code}`,
    title: getTitle(error.code),
    status: error.httpStatus,
    code: error.code,
    detail: error.message,
    instance: ctx.instance,
    request_id: ctx.request_id,
    timestamp: ctx.timestamp,
    ...(error instanceof ValidationError && { errors: error.errors }),
    ...(error.metadata && { metadata: error.metadata }),
  };

  return reply.status(error.httpStatus).send(payload);
}
```

---

## 5. Localizzazione

### 5.1 Strategia

I messaggi di errore hanno **due livelli**:

1. **`detail` server-side**: italiano in v1, serve come fallback e per log
2. **Messaggio client-side**: il frontend usa `code` per lookup in un file di traduzioni locale (permette miglior UX: personalizzazione per contesto, formattazione ricca)

### 5.2 File traduzioni client

```typescript
// packages/shared/src/i18n/error-messages.it.ts

export const errorMessagesIT = {
  // Generic
  'generic.internal_error': {
    title: 'Qualcosa è andato storto',
    message: 'Si è verificato un errore inatteso. Riprova tra qualche istante.',
  },
  'generic.rate_limit_exceeded': {
    title: 'Troppe richieste',
    message: 'Hai fatto troppe operazioni in poco tempo. Attendi qualche minuto.',
  },

  // Auth
  'auth.login.invalid_credentials': {
    title: 'Credenziali errate',
    message: 'Email o password non corretti.',
  },
  'auth.login.account_locked': {
    title: 'Account bloccato',
    message: 'Troppi tentativi falliti. Riprova tra 15 minuti o recupera la password.',
  },

  // Vehicle
  'vehicle.creation.duplicate_vin': {
    title: 'Veicolo già presente',
    message: 'Un veicolo con questo VIN è già registrato nel sistema.',
    actionSuggestion: 'Cerca il veicolo esistente o verifica il VIN inserito.',
  },
  'vehicle.claim.already_owned_by_other': {
    title: 'Veicolo già reclamato',
    message: 'Questo veicolo è già associato a un altro proprietario.',
    actionSuggestion: 'Contatta il venditore per il passaggio di proprietà o usa la procedura di claim autonomo.',
  },
  'vehicle.modification.vin_immutable': {
    title: 'VIN non modificabile',
    message: 'Il numero di telaio di un veicolo certificato non può essere cambiato.',
    actionSuggestion: 'Se il VIN è sbagliato, contatta il supporto.',
  },

  // Intervention
  'intervention.modification.locked': {
    title: 'Intervento bloccato',
    message: "La finestra di modifica libera è scaduta. Puoi ancora modificare l'intervento, ma la modifica sarà visibile al cliente.",
  },
  'intervention.creation.odometer_decrease_warning': {
    title: 'Km sospetti',
    message: 'I chilometri inseriti sono inferiori a quelli dell\'ultimo intervento. Vuoi procedere comunque?',
  },

  // ... altre traduzioni
};
```

### 5.3 Convenzione `actionSuggestion`

Quando possibile, includere un suggerimento di azione:

- Non solo "errore XYZ" ma "errore XYZ + cosa fare"
- Esempio: "Email già registrata" + "Vuoi fare login o recuperare la password?"

Questa è UX, non normativo — ma encouraged.

### 5.4 Roadmap internationalization

**v1**: solo italiano, file IT unico.
**v2**: setup i18n completo con fallback EN. Ogni modulo frontend espone `t(code)` helper.

---

## 6. Pattern per aggiungere nuovi error code

### 6.1 Checklist quando si aggiunge un nuovo error code

1. [ ] **Scegli un codice seguendo la convenzione** `area.sub_area.specifico`
2. [ ] **Verifica che non esista già** (grep nel codebase)
3. [ ] **Aggiungilo nel catalogo** di questa appendice
4. [ ] **Scegli lo status HTTP** appropriato
5. [ ] **Scegli la severity**
6. [ ] **Se è legato a una BR**, cita `BR-XXX` nel catalogo
7. [ ] **Crea o estendi la classe eccezione** in `packages/api/src/errors/`
8. [ ] **Aggiungi traduzione IT** in `errorMessagesIT`
9. [ ] **Scrivi un test** che verifica che l'endpoint ritorna il codice corretto
10. [ ] **Documenta nell'Appendice A** (se nuovo endpoint) o come errore possibile di uno esistente

### 6.2 Template per nuova eccezione

```typescript
// packages/api/src/errors/<module>.ts

export class MyNewError extends BusinessError {
  constructor(contextValue: string) {
    super(
      'module.sub_module.specific_error',        // code
      `Descrizione dettagliata con ${contextValue}`,  // message
      { context_value: contextValue },           // metadata
      'warning'                                   // severity
    );
  }
}
```

### 6.3 Template per test

```typescript
describe('POST /vehicles — duplicate VIN handling', () => {
  it('should return 409 with vehicle.creation.duplicate_vin code', async () => {
    await VehicleFactory.create({ vin: 'EXISTING_VIN_HERE' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { /* ... */ vin: 'EXISTING_VIN_HERE' /* ... */ },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe('vehicle.creation.duplicate_vin');
    expect(body.type).toBe('https://api.garageos.it/errors/vehicle.creation.duplicate_vin');
    expect(body.metadata).toHaveProperty('existing_vehicle_id');
    expect(body.request_id).toBeTruthy();
  });
});
```

### 6.4 Quando NON creare un nuovo error code

Evitare proliferazione inutile di codici:

- ❌ **Un codice per ogni campo mal validato**: usa `validation.failed` con `errors[]`
- ❌ **Un codice per ogni condizione di errore minore**: se non richiede handling specifico dal client, usa un codice generico
- ❌ **Due codici per la stessa situazione**: se "duplicato" può capitare in contesti diversi, lo stesso codice va bene (il path URL aiuta a distinguere)

✅ **Crea un codice nuovo quando:**
- Il client deve fare qualcosa di specifico in quella situazione
- C'è una BR precisa da far rispettare
- Il codice verrà usato in messaggi di aiuto contestuali

---

## 7. Indice alfabetico rapido

Elenco di tutti gli error code v1.0 in ordine alfabetico, per ricerca rapida:

```
admin.impersonation.not_allowed
admin.impersonation.target_not_found
admin.permission.denied
attachment.deletion.locked
attachment.download.permission_denied
attachment.not_found
attachment.upload.confirmation_mismatch
attachment.upload.intervention_dispute_not_owner
attachment.upload.intervention_dispute_role_denied
attachment.upload.mime_not_allowed
attachment.upload.no_open_dispute
attachment.upload.officina_only
attachment.upload.officina_pool_not_allowed_for_private
attachment.upload.private_intervention_not_found
attachment.upload.too_large
attachment.upload.too_many
attachment.upload.url_expired
auth.2fa.invalid_code
auth.2fa.required
auth.cognito_unavailable
auth.forbidden.super_admin_required
auth.forbidden.wrong_pool
auth.login.account_inactive
auth.login.account_locked
auth.login.email_not_verified
auth.login.invalid_credentials
auth.password.too_weak
auth.password_reset.invalid_token
auth.permission.denied
auth.signup.email_already_registered
auth.signup.email_domain_blocked
auth.tenant.suspended
auth.token.expired
auth.token.invalid
auth.token.missing
auth.token.revoked
customer.business_data_missing
customer.deletion.active_transfers
customer.email_duplicate
customer.not_found
customer.pii_not_accessible
customer.tax_code_invalid
customer.update.empty_body
customer.update.unknown_field
deadline.completion.already_completed
deadline.completion.intervention_mismatch
deadline.creation.duplicate_warning
deadline.creation.missing_criterion
deadline.modification.permission_denied
deadline.not_found
deadline.recurring.config_invalid
gdpr.deletion.active_data
gdpr.export.in_progress
gdpr.export.not_ready
generic.internal_error
generic.not_found
generic.rate_limit_exceeded
generic.service_unavailable
intervention.cancellation.already_cancelled
intervention.cancellation.permission_denied
intervention.cancellation.reason_too_short
intervention.creation.date_before_registration
intervention.creation.date_future
intervention.creation.immutable_field
intervention.creation.odometer_decrease_warning
intervention.creation.parts_invalid
intervention.creation.type_not_found
intervention.dispute.already_exists
intervention.dispute.attachment_already_claimed
intervention.dispute.attachment_not_found
intervention.dispute.attachment_not_processed
intervention.dispute.description_too_short
intervention.dispute.not_owner
intervention.dispute.response.attachments_require_dispute_id
intervention.dispute.response.description_too_short
intervention.dispute.response.no_active_dispute
intervention.dispute.response.not_your_intervention
intervention.dispute.response.permission_denied
intervention.modification.cancelled
intervention.modification.disputed
intervention.modification.locked
intervention.modification.revision_reason_required
intervention.not_found
intervention.revisions.not_owner
location.cannot_disable_last
location.cannot_remove_primary
location.not_found
location.not_in_tenant
me.intervention.not_found
me.notification-preferences.update.empty_body
me.notification-preferences.update.unknown_field
me.push-token.not_found
me.push-token.register.invalid_token
me.push-token.register.unknown_field
notification.push_token.already_registered
notification.push_token.invalid
notification.rate_limit
private_intervention.date_future
private_intervention.not_found
private_intervention.not_owner
private_intervention.rate_limit
private_intervention.vehicle_not_owned
system.database.connection_failed
system.email.send_failed
system.push.send_failed
system.s3.upload_failed
system.scheduler.schedule_failed
tenant.billing.past_due
tenants.me.update.empty_body
tenants.me.update.unknown_field
tenant.not_found
tenant.vat_number_duplicate
tenant.vat_number_invalid
transfer.acceptance.already_completed
transfer.acceptance.expired
transfer.acceptance.invited_email_mismatch
transfer.acceptance.not_pending_recipient
transfer.acceptance.self_not_allowed
transfer.claim_without_seller.libretto_required
transfer.claim_without_seller.ocr_mismatch
transfer.confirmation.expired
transfer.confirmation.not_from_customer
transfer.confirmation.not_pending_seller
transfer.confirmation.ownership_conflict
transfer.creation.already_pending
transfer.creation.not_current_owner
transfer.creation.vehicle_not_certified
transfer.creation.vehicle_not_found
transfer.not_found
transfer.rejection.not_pending
transfer.rejection.not_permitted
user.already_active
user.cannot_delete_self_via_admin
user.invitation.accept_password_policy
user.invitation.already_accepted
user.invitation.cognito_unavailable
user.invitation.duplicate_pending
user.invitation.email_already_active
user.invitation.email_in_other_tenant
user.invitation.email_mismatch
user.invitation.email_soft_deleted_in_tenant
user.invitation.expired
user.invitation.location_invalid
user.invitation.not_found
user.last_super_admin
user.location_invalid
user.location_required_for_mechanic
user.not_found
users.me.avatar.invalid_mime
users.me.avatar.s3_unavailable
users.me.avatar.upload_not_found
users.me.update.empty_body
users.me.update.unknown_field
validation.failed
validation.schema_mismatch
vehicle.access.forbidden
vehicle.archived
vehicle.certification.libretto_required
vehicle.certification.not_pending
vehicle.claim.already_owned_by_other
vehicle.claim.already_owned_by_you
vehicle.claim.archived
vehicle.claim.pending_not_claimable
vehicle.creation.duplicate_plate_warning
vehicle.creation.duplicate_vin
vehicle.creation.invalid_vin_checksum
vehicle.creation.plate_invalid_format
vehicle.creation.vin_invalid_format
vehicle.creation.year_out_of_range
vehicle.garage_code.invalid_format
vehicle.garage_code.not_found
vehicle.modification.archived
vehicle.modification.certified_required
vehicle.modification.vin_immutable
vehicle.not_certified
vehicle.not_found
vehicle.pending.duplicate_vin_certified
vehicle_tag.audit_insert_failed
vehicle_tag.never_printed
vehicle_tag.render_failed
vehicle_tag.s3_head_failed
vehicle_tag.s3_upload_failed
```

**Totale: ~156 error code documentati in v1.0** (aggiornato post F-OFF-104 tag PDF, +6 codici: `vehicle.archived`, `vehicle.not_certified`, `vehicle_tag.s3_head_failed`, `vehicle_tag.s3_upload_failed`, `vehicle_tag.render_failed`, `vehicle_tag.audit_insert_failed`). (aggiornato post F-OFF-004 multi-user, +11 codici F-OFF-004 + 3 codici F-OFF-004 reactivation slice 2026-05-21; stale spec codes `user.cannot_remove_last_super_admin` + `user.role_change_would_orphan_tenant` sostituiti da `user.last_super_admin`).

---

*Fine Appendice G — Error Codes Catalog*
