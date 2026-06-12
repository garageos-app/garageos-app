# Runbook — Smoke email e2e via Resend (post #199/#200)

**Stato: ESEGUITO E PASS 2026-06-12** (operatore: Michele; ambiente: prod
`app.garageos.aifollyadvisor.com`, `EMAIL_PROVIDER=resend`, dominio mittente
`garageos.aifollyadvisor.com` su Resend EU).

Copre tutti i sender email del sistema dopo lo switch a Resend (#199) e la
nuova notifica di creazione intervento (#200). Account cliente di test:
Pippo Baudo `matulamichele+b2cpwd@gmail.com` (customer `731b3cb3`), veicolo
`GG123ZZ` (vehicle `1535dd8b-0433-4ef1-ba9c-30d1b4f901a8`).

| # | Percorso | Trigger | Esito |
|---|---|---|---|
| 1 | `verify-email` (signup cliente) | Signup `matulamichele+resendsmoke@gmail.com` → 201 | ✅ PASS 2026-06-11 (sessione #199) — email arrivata via Resend |
| 2 | `intervention.revised` (BR-064) | Modifica intervento su GG123ZZ dalla web app | ✅ PASS 2026-06-12 — email a `+b2cpwd` |
| 3 | `intervention.cancelled` (BR-066) | Annullamento dello stesso intervento | ✅ PASS 2026-06-12 — email a `+b2cpwd` |
| 4 | Invito utente officina | Impostazioni → Utenti → invito a `matulamichele+invitesmoke@gmail.com` (mechanic) | ✅ PASS 2026-06-12 — email arrivata; invito NON accettato (residuo da revocare/pulire) |
| 5 | `intervention.created` (BR-157, #200) | Nuovo intervento su GG123ZZ post-deploy `a25da7c` | ✅ PASS 2026-06-12 — email "Nuovo intervento registrato sul tuo veicolo" a `+b2cpwd` |
| 6 | `deadline.reminder` | — | ⏭️ SKIPPED — stesso canale `sendEmail()`/transport dei punti 2-5; già smokato e2e via push (2026-06-12, runbook notification-tap) |

Note:

- La push `intervention.created` non è stata verificata su device in questo
  smoke (token deregistrato dal logout dello smoke tap deep-link); il canale
  push per tipo evento è già coperto da test + smoke push e2e (#196). Il tap
  deep-link del tipo `created` va verificato alla **prossima build EAS**
  (il case di routing è in #200, il JS vive nell'APK).
- Residui prod generati da questo smoke → censiti nel runbook
  `prod-db-cleanup.md` (sezioni 5-8): customer `+resendsmoke`, invito
  `+invitesmoke`, 2 interventi smoke su GG123ZZ, revisioni di test su
  `a2a66c05`.
