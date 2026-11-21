#!/bin/sh
set -eu

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set execution_password="$EXECUTION_DB_PASSWORD" \
  --set business_password="$BUSINESS_DB_PASSWORD" <<'SQL'
CREATE ROLE execution LOGIN PASSWORD :'execution_password';
CREATE ROLE business LOGIN PASSWORD :'business_password';

CREATE DATABASE execution OWNER execution;
CREATE DATABASE business OWNER business;

REVOKE ALL ON DATABASE execution FROM PUBLIC;
REVOKE ALL ON DATABASE business FROM PUBLIC;
SQL
