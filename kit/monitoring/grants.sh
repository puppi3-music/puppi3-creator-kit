#!/bin/sh
# Grafana's read-only logins (kit/monitoring/compose.yaml runs it at every start), password RO_PASSWORD:
#   grants.sh ghost    in the mysql image: grafana_ro on Ghost's MySQL, SELECT on stacks/ghost/grafana-ro.sh's TABLES
#   grants.sh postiz   in the postgres image: grafana_ro on Postiz's Postgres, SELECT on what the Social panels read
# Waits (up to 20 minutes) for the tables: Ghost and Postiz make them at their first start.
set -eu
wait_for() { # <what> <command...>: until the command works
    what=$1; shift
    i=0
    until "$@" >/dev/null 2>&1; do
        i=$((i + 1))
        [ "$i" -le 240 ] || { echo "grants: gave up waiting for $what" >&2; exit 1; }
        sleep 5
    done
}
case "$1" in
ghost)
    export MYSQL_PWD="$DB_PASSWORD"
    sql() { mysql -h"$DB_HOST" -u"$DB_USER" "$@"; }
    # the last tables Ghost's migrations make among those granted
    wait_for "Ghost's tables" sql -e "SELECT 1 FROM \`$DB_NAME\`.redirects LIMIT 1; SELECT 1 FROM \`$DB_NAME\`.members_click_events LIMIT 1"
    sql -e "CREATE USER IF NOT EXISTS 'grafana_ro'@'%' IDENTIFIED BY '$RO_PASSWORD';
            ALTER USER 'grafana_ro'@'%' IDENTIFIED BY '$RO_PASSWORD';"
    bash /grafana-ro.sh --sql "$DB_NAME" | sql
    echo "grants: grafana_ro reads Ghost's dashboard tables"
    ;;
postiz)
    case ",$MODULES," in *,social,*) ;; *) echo "grants: no social module, nothing to do"; exit 0 ;; esac
    tables='"Post", "Integration", "Tags", "TagsPosts"'
    # all four (Postiz's migrations make them one by one)
    tables_ready() {
        [ "$(psql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
            AND tablename IN ('Post', 'Integration', 'Tags', 'TagsPosts')")" = 4 ]
    }
    wait_for "Postiz's tables" tables_ready
    psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grafana_ro') THEN CREATE ROLE grafana_ro LOGIN; END IF;
END \$\$;
ALTER ROLE grafana_ro WITH LOGIN PASSWORD '$RO_PASSWORD';
GRANT CONNECT ON DATABASE postiz TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON $tables TO grafana_ro;
SQL
    echo "grants: grafana_ro reads $tables"
    ;;
*) echo "grants.sh ghost|postiz" >&2; exit 2 ;;
esac
