# F-CLI-401 PR3 — Scheduler scadenza 7 giorni (transfer expiry)

**Data:** 2026-06-10
**Feature:** F-CLI-401 / F-CLI-403 (passaggio di proprietà lato cliente)
**Business rule:** BR-043 (timeout 7gg → `status=expired`, veicolo resta al cedente), BR-047 (un solo transfer attivo per veicolo)
**Tipo:** API + Infra (CDK). Nessuna migration, nessuna nuova dipendenza, nessun nuovo error code.

## What

Terza PR dell'arco transfer cliente. Aggiunge un **job periodico** che porta a
`status='expired'` i `VehicleTransfer` rimasti in `pending_recipient` o
`pending_seller_confirmation` oltre il loro `expiresAt`, lasciando il veicolo al
cedente (BR-043 timeout). Include l'hardening del confirm-CAS suggerito dal final
review di PR2.

PR1 (#180) ha creato avvio+lettura; PR2 (#181) le transizioni
accept/confirm/reject + swap atomico. Il codice PR2 è già forward-compatible:
accept/confirm restituiscono 410 (`transfer.acceptance.expired` /
`transfer.confirmation.expired`) sullo status `expired`.

## Why

BR-043: «se il cedente non conferma entro 7 giorni dall'accettazione, il transfer
scade (`status=expired`) e il veicolo resta al cedente.» Lo stesso vale per il
recipient che non accetta entro 7gg dalla creazione (`pending_recipient`).

**Osservazione di scoping centrale:** la correttezza *per le parti* è già garantita
dal read-guard delle route accept/confirm (`expiresAt < Date.now()` →
410), indipendentemente dallo sweep. Lo sweep è **housekeeping**:

1. libera lo slot dell'indice partial-unique `uq_transfer_vehicle_active`
   (BR-047) così il cedente può avviare un nuovo transfer dopo la scadenza;
2. mantiene liste/dettaglio coerenti (mostrano `expired` invece di un
   `pending_*` stantio).

Per questo la **cadenza non è sul percorso di sicurezza** → giornaliera basta.

## Architettura

### Trigger ricorrente (nuovo, NON il pattern one-shot dei deadline)

Esistono due pattern di scheduling nel codebase:

- **one-shot per-riga** (deadline reminders): `CfnSchedule` creati a runtime via
  SDK nel gruppo `garageos-deadlines`, instradati da `withSchedulerGuard`
  (matcha `event.source === 'aws.scheduler'` + `event.detail.{deadlineNotificationId,reminderType}`);
- **ricorrente cron singleton** (`WarmingSchedule`): `CfnSchedule` statico in CDK,
  payload top-level `{source:'warming'}`, instradato da `withWarmingGuard`
  (matcha `event.source === 'warming'` top-level).

L'expiry è uno **sweep periodico set-based** → ricalca il pattern **ricorrente
cron singleton** (WarmingSchedule), non il one-shot.

#### CDK — `infrastructure/lib/constructs/scheduler.ts`

Nuova `CfnSchedule` singleton `TransferExpirySchedule`:

- gruppo `default` (come WarmingSchedule; il gruppo `garageos-deadlines` resta
  riservato agli schedule runtime per-deadline);
- `scheduleExpression: 'cron(0 3 * * ? *)'`, `scheduleExpressionTimezone: 'UTC'`
  (housekeeping notturno indifferente al fuso; UTC evita complicazioni DST —
  diverso dal warming che è legato agli orari ufficina Europe/Rome);
- `flexibleTimeWindow: { mode: 'OFF' }`;
- target: il Lambda API esistente (`props.lambdaFunction`), `roleArn` =
  `this.schedulerRole.roleArn` esistente (già concede `lambda:InvokeFunction`
  sul Lambda ARN — **nessuna nuova IAM**);
- `input: JSON.stringify({ source: 'transfer-expiry' })`;
- `retryPolicy: { maximumRetryAttempts: 2 }` (lo sweep è idempotente, un retry su
  errore transitorio è sicuro);
- `state: props.warmingEnabled ? 'ENABLED' : 'DISABLED'`.

**Decisione (no ambiguità):** lo schedule è gateato dal **flag esistente
`warmingEnabled`** — l'unico gate ambiente già presente che dice «in questo
ambiente gli EventBridge schedule sono attivi» (true in produzione, false negli
ambienti effimeri). Nessun nuovo prop di enablement. Il **nome** dello schedule è
una costante interna al construct (`'garageos-transfer-expiry'`), non un prop,
simmetrica a come `WarmingSchedule` riceve il suo nome ma senza aggiungere
superficie di configurazione: nessuna nuova prop al construct, nessuna modifica a
`main-stack.ts` / `config/production.ts`.

#### Routing — `packages/api/src/lambda-transfer-expiry.ts` (nuovo)

Nuovo higher-order guard `withTransferExpiryGuard`, mirror esatto di
`withWarmingGuard`:

```ts
export function withTransferExpiryGuard(
  inner: LambdaHandler,
  handler: TransferExpiryHandler,
): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'transfer-expiry'
    ) {
      return handler();
    }
    return inner(event, context, callback);
  };
}
```

Match top-level `event.source === 'transfer-expiry'` → disgiunto da `'warming'`
e da `'aws.scheduler'`: **nessuna ambiguità** con gli altri due guard.

#### Catena `index.ts`

Inserito tra warming e l'adapter Fastify (ordine esterno → interno):

```
withWarmingGuard(
  withTransferExpiryGuard(
    withSchedulerGuard(schedulerHandler)(awsLambdaFastify(app)),
    transferExpiryHandler,
  ),
  warmup,
)
```

`transferExpiryHandler` = `() => processTransferExpiry({ app: { withContext: app.withContext.bind(app), log: app.log } })`.

### Handler dello sweep — `packages/api/src/lib/transfers/expire-transfers.ts` (nuovo)

```ts
export interface TransferExpiryResult {
  sweptCount: number;
}

export async function processTransferExpiry(input: {
  app: AppLike; // { withContext, log } — stesso AppLike di scheduler-invocation
}): Promise<TransferExpiryResult> {
  return input.app.withContext({ role: 'admin' }, async (tx) => {
    const now = new Date();
    const result = await tx.vehicleTransfer.updateMany({
      where: {
        status: { in: ['pending_recipient', 'pending_seller_confirmation'] },
        expiresAt: { lt: now },
      },
      data: { status: 'expired' },
    });
    input.app.log.info({ transferExpiry: { sweptCount: result.count } });
    return { sweptCount: result.count };
  });
}
```

Punti chiave:

- **`role: 'admin'`** — lo sweep è cross-tenant/cross-customer e privo di JWT,
  identica ragione del deadline scheduler (un ctx `{}` negherebbe in silenzio le
  scritture RLS — vedi `feedback_withcontext_empty_blocks_rls_writes`).
- **Esclude `pending_validation`** — è F-CLI-404/BR-044 (claim-without-seller):
  semantica opposta (no-risposta ⇒ *approvato*, non scaduto) e comunque rinviato.
  Lo sweep tocca solo i due stati della doppia-conferma BR-043.
- **Solo `vehicle_transfers`** — nessun tocco a `vehicle_ownerships` (BR-043: il
  veicolo resta al cedente). Uscendo da `pending_*` la riga esce dal predicato
  `uq_transfer_vehicle_active` ⇒ slot BR-047 liberato automaticamente.
  **Lock graph: un solo nodo, nessun ordine di lock da tracciare.**
- **Niente** `completedAt`/`rejectedReason` (restano null: non è completato né
  rifiutato).
- **Idempotente**: la `WHERE` su `status IN (pending_*)` fa sì che una seconda
  esecuzione (retry EventBridge o sweep successivo) non ri-tocchi righe già
  flippate ⇒ `count: 0`, innocuo.
- **Propagazione errori**: se `updateMany` lancia (DB down) l'errore propaga ⇒ il
  Lambda risponde non-2xx ⇒ EventBridge ritenta (≤2 attempt). Coerente col
  contratto del deadline scheduler.

### Hardening confirm-CAS — `packages/api/src/lib/transfer-swap.ts`

Chiude la finestra sub-ms tra il read-guard `expiresAt < Date.now()`
(`me-transfers.ts:308`) e il CAS dello swap. Si aggiunge il vincolo temporale al
CAS step-1:

```ts
const cas = await tx.vehicleTransfer.updateMany({
  where: {
    id: transferId,
    status: 'pending_seller_confirmation',
    expiresAt: { gt: now },
  },
  data: { status: 'completed', completedAt: now },
});
if (cas.count === 0) {
  // Distinguere scadenza-nel-frattempo da race con confirm concorrente:
  // re-read leggero della riga sul ramo di fallimento (raro).
  const current = await tx.vehicleTransfer.findFirst({
    where: { id: transferId },
    select: { status: true, expiresAt: true },
  });
  if (current && (current.status === 'expired' || current.expiresAt.getTime() <= now.getTime())) {
    throw businessError('transfer.confirmation.expired', 410, 'Trasferimento scaduto.');
  }
  throw businessError(
    'transfer.confirmation.not_pending_seller',
    422,
    'Trasferimento non in attesa di conferma del cedente.',
  );
}
```

Belt-and-suspenders col read-guard e con lo sweep: il CAS rifiuta lo swap se la
riga è scaduta per timestamp, a prescindere dal fatto che lo sweep PR3 l'abbia già
flippata a `expired`. Il re-read sul ramo di fallimento restituisce il **410**
corretto (`transfer.confirmation.expired`) che il client PR4 si aspetta, anziché
il 422 generico; il 422 (`not_pending_seller`) resta per la race con un confirm
concorrente (status non più pending ma non scaduto). `now` è già passato a
`confirmTransferSwap` dalla route.

## Componenti (riepilogo file)

| File | Tipo | Cosa |
|---|---|---|
| `infrastructure/lib/constructs/scheduler.ts` | modificato | + `TransferExpirySchedule` CfnSchedule (cron giornaliero UTC), nome costante interno, gate `warmingEnabled` |
| `packages/api/src/lambda-transfer-expiry.ts` | nuovo | `withTransferExpiryGuard` + tipo handler |
| `packages/api/src/lib/transfers/expire-transfers.ts` | nuovo | `processTransferExpiry` (sweep set-based) |
| `packages/api/src/index.ts` | modificato | inserimento guard nella catena + handler wiring |
| `packages/api/src/lib/transfer-swap.ts` | modificato | hardening CAS `expiresAt:{gt:now}` + re-read→410 |

## Error handling

- **Nessun nuovo error code.** `transfer.acceptance.expired` (410) e
  `transfer.confirmation.expired` (410) già registrati in APPENDICE_G; lo sweep
  non produce errori user-facing.
- Lo sweep non lancia mai in modo non gestito verso EventBridge salvo errore DB
  reale (ritentato ≤2 volte).
- L'hardening riusa `transfer.confirmation.expired` / `transfer.confirmation.not_pending_seller`
  esistenti.

## Notifiche — DIFFERITE

Coerente con PR2 (che ha differito le notifiche `ownership_transfer`): nessuna
email/push di scadenza in questa PR. Solo marker `// TODO(F-CLI-notifications)`
nello handler. La notifica di scadenza al cedente/cessionario arriverà con l'arco
notifiche.

## Testing

**Unit (`packages/api`, Vitest):**

- `expire-transfers.test.ts` (FakePrisma): flippa `pending_recipient` scaduto →
  `expired`; flippa `pending_seller_confirmation` scaduto → `expired`; **non**
  tocca `pending_validation` scaduto; **non** tocca `pending_*` non-scaduto
  (`expiresAt > now`); **non** tocca `completed`/`rejected`/`expired`; ritorna
  `sweptCount` corretto; idempotenza (seconda run → 0).
- `lambda-transfer-expiry.test.ts`: instrada `{source:'transfer-expiry'}`
  all'handler; lascia passare a inner gli eventi APIGW, warming e deadline-scheduler.
- `transfer-swap.test.ts` (esteso): CAS con `expiresAt > now` passa; CAS con riga
  scaduta (`expiresAt <= now` / status `expired`) → re-read → `transfer.confirmation.expired`
  (410); race concorrente (status non più `pending_seller_confirmation`, non
  scaduto) → `not_pending_seller` (422). Verificare che i test esistenti del
  confirm passino seminando `expiresAt` futuro nelle fixture.

**Integration (`packages/api`, Postgres reale, CI-only):**

- seed transfer `pending_recipient` + `pending_seller_confirmation` con
  `expiresAt` nel passato → `processTransferExpiry` → entrambi `expired`; un nuovo
  `POST /v1/me/transfers` sullo stesso veicolo ora riesce (slot
  `uq_transfer_vehicle_active` liberato); `pending_validation` scaduto resta
  intatto; `vehicle_ownership` del cedente invariata.

**CDK:** `cdk-synth` su CI verifica la nuova `CfnSchedule`. Nessuna unit infra
nuova obbligatoria (synth è il gate, CLAUDE.md).

## Deploy

La `CfnSchedule` richiede `cdk deploy` (operatore) per attivarsi in prod. Guard +
handler sono **inerti** finché lo schedule non esiste (nessun evento
`transfer-expiry` viene mai consegnato), quindi il merge è sicuro senza deploy
immediato. Da segnalare come pending operatore non-bloccante nel checkpoint.

## Out of scope / Deferred

- Notifiche di scadenza (push/email) → arco notifiche.
- `pending_validation` / claim-without-seller (F-CLI-404) → arco futuro a sé.
- `email_invitation` come metodo → finché SES/Resend non sbloccato.
- PR4 mobile (UI transfer cliente).

## Vincoli CLAUDE.md rispettati

- Nessuna migration (enum `expired` già in `TransferStatus`).
- Nessuna nuova dipendenza.
- Nessun nuovo error code (riuso APPENDICE_G esistenti).
- Nessuna policy RLS toccata (sweep sotto `role:'admin'`, vehicle_transfers RLS
  invariata).
