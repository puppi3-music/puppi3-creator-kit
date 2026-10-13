#!/usr/bin/env bash
# k8s/migrate/migrate.sh says what it does and how to run it.
exec "$(dirname "$0")/migrate.sh" to-nas "$@"
