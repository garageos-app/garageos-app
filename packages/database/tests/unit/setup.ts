// Unit tests never talk to Postgres, but importing the factories pulls
// in src/client.ts which throws at module load if DATABASE_URL is unset.
// A placeholder URL is enough because PrismaPg opens the TCP connection
// lazily on the first query — which unit tests never issue.
process.env.DATABASE_URL ??= 'postgresql://unit:unit@localhost:5432/unit_no_connect';
