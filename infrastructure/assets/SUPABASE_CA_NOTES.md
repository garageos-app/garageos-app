# Supabase CA certificate

## Origin

Downloaded from `https://supabase.com/dashboard/project/<project-ref>/settings/database`,
section "SSL Configuration" → "Download certificate". Public root CA used by Supabase
to sign their Postgres pooler intermediate certificates.

This file is NOT a secret — it is the public root that any client validating the
Supabase pooler chain must trust. It is committed to the repo so the Lambda bundle
is reproducible without network access at deploy time.

## Current cert metadata

- **Subject:** `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA`
- **Issuer:** `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA`
- **Valid until:** `Apr 26 10:56:53 2031 GMT`
- **Vendored on:** 2026-04-29 (PR — TLS verification proper)

## Rotation

When Supabase publishes a new root CA (last rotation: 2021), repeat the download
step above and replace this file with a commit. Update the metadata block accordingly.

If `notAfter` is approaching (within 12 months), proactively check the Supabase
dashboard for a successor cert before expiry triggers a production outage.

## Verification commands

```bash
# Subject and issuer
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -subject -issuer

# Validity dates
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -dates

# Full text
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -text
```
