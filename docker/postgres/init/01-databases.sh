#!/bin/sh
set -eu

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set execution_password="$EXECUTION_DB_PASSWORD" \
  --set business_password="$BUSINESS_DB_PASSWORD" \
  --set business_reader_password="$BUSINESS_READER_DB_PASSWORD" <<'SQL'
CREATE ROLE execution LOGIN PASSWORD :'execution_password';
CREATE ROLE business LOGIN PASSWORD :'business_password';
-- The evaluator's: may read the business database, nothing else.
CREATE ROLE business_reader LOGIN PASSWORD :'business_reader_password';

CREATE DATABASE execution OWNER execution;
CREATE DATABASE business OWNER business;

REVOKE ALL ON DATABASE execution FROM PUBLIC;
REVOKE ALL ON DATABASE business FROM PUBLIC;
GRANT CONNECT ON DATABASE business TO business_reader;

-- The business mock creates its tables later, as their owner.
\connect business
GRANT USAGE ON SCHEMA public TO business_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE business IN SCHEMA public GRANT SELECT ON TABLES TO business_reader;
SQL
