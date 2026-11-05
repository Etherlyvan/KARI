#!/bin/sh
set -eu

# Official postgres entrypoint runs this only when initializing an empty data volume.
# Do not enable shell tracing or psql echo: passwords must never be printed.
if [ "${POSTGRES_DB:-}" != "kari" ] || [ "${POSTGRES_USER:-}" != "kari_admin" ]; then
  echo 'KARI initialization requires the configured kari database/admin role.' >&2
  exit 1
fi
for name in POSTGRES_PASSWORD KARI_DB_PASSWORD; do
  case "$name" in
    POSTGRES_PASSWORD) value=${POSTGRES_PASSWORD:-} ;;
    KARI_DB_PASSWORD) value=${KARI_DB_PASSWORD:-} ;;
  esac
  case "$value" in
    ''|*[!A-Za-z0-9_-]*) echo 'Database passwords must contain only URL-safe letters, digits, underscores and hyphens.' >&2; exit 1 ;;
  esac
  if [ "${#value}" -lt 24 ] || [ "${#value}" -gt 128 ]; then
    echo 'Database passwords must each contain 24-128 URL-safe characters.' >&2
    exit 1
  fi
done
unset value
if [ "$POSTGRES_PASSWORD" = "$KARI_DB_PASSWORD" ]; then
  echo 'Admin and application database passwords must be different.' >&2
  exit 1
fi

psql --no-psqlrc --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv runtime_password KARI_DB_PASSWORD
CREATE ROLE kari_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
\unset runtime_password
REVOKE ALL ON DATABASE kari FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE kari TO kari_app;
GRANT USAGE ON SCHEMA public TO kari_app;
SQL
