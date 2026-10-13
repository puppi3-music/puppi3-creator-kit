#!/bin/bash
# Grafana's read-only login to Ghost's database (grafana_ro): SELECT on only the tables the site's
# dashboards and alert rules read, so a Grafana user can't read staff logins, sessions, API keys or Ghost's
# settings (Stripe, Mailgun...) through it. Production, on the server:
#   sudo bash <DATA_DIR>/puppi3/grafana-ro.sh
# then restart Grafana: its open connections keep their old rights until they reconnect.
# Staging's refresh.sh gives its copy the same grants (--sql <database> prints the statements).
# A panel reading another table needs it added to TABLES; python3 stacks/monitoring/grafana/ro-tables.py --check (run by the
# pre-commit hook) lists any the dashboards read that aren't here. A table that's here but not in Ghost's
# database stops the grant with "Table ... doesn't exist".
set -euo pipefail
TABLES="comments email_recipient_failures email_recipients email_spam_complaint_events emails members
        members_click_events members_created_events members_subscribe_events posts redirects"

grants() { # <database>: everything taken away, then SELECT on each table
  printf "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'grafana_ro'@'%%';\n"
  for t in $TABLES; do printf "GRANT SELECT ON \`%s\`.\`%s\` TO 'grafana_ro'@'%%';\n" "$1" "$t"; done
}
if [ "${1:-}" = --sql ]; then grants "${2:?--sql <database>}"; exit 0; fi

die() { printf 'grafana-ro: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
DIR=$(cd "$(dirname "$0")" && pwd)
# KEY=value from the stack's .env, quotes stripped (as refresh.sh does)
envval() { sed -n "s/^$1=//p" "$DIR/.env" 2>/dev/null | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
DB_USER=$(envval database__connection__user); DB_USER=${DB_USER:-root}
DB_PW=$(envval database__connection__password); DB_PW=${DB_PW:-example}
DB_NAME=$(envval database__connection__database); DB_NAME=${DB_NAME:-ghost-puppi3}
DB=$(docker ps -q --filter label=com.docker.compose.project=puppi3 --filter label=com.docker.compose.service=db | head -1)
[ -n "$DB" ] || die "production's database container isn't running"
sql() { docker exec -i -e MYSQL_PWD="$DB_PW" "$DB" mysql -u"$DB_USER" "$@"; }

[ "$(sql -N -e "SELECT COUNT(*) FROM mysql.user WHERE user = 'grafana_ro' AND host = '%'")" = 1 ] \
  || die "there's no grafana_ro login in production's MySQL (see the repo guide's Grafana section)"
grants "$DB_NAME" | sql
echo "grafana_ro can now read only these tables of $DB_NAME:"
sql -N -e "SHOW GRANTS FOR 'grafana_ro'@'%'" | sed 's/^/  /'
echo "Restart Grafana (the monitoring stack's grafana container) so its open connections pick this up."
