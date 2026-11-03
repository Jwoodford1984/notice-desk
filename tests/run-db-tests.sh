#!/usr/bin/env bash
# Applies the migrations and seed to a throwaway Postgres database, then runs
# the RLS/workflow checks. Needs a local Postgres 15+ you can create databases on.
# Usage: PGHOST=localhost PGPORT=5432 PGUSER=postgres ./tests/run-db-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=notice_desk_test
P="psql -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB"
$P -d $DB -f tests/supabase_stubs.sql
for f in supabase/migrations/*.sql; do echo "applying $f"; $P -d $DB -f "$f"; done
$P -d $DB -f supabase/seed.sql > /dev/null
$P -d $DB -f tests/rls_test.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
