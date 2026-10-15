#!/usr/bin/env bash
# The sharing service's chores (service/, docs/PLAN.md M2): nobody can sign up, so writers
# are invited from here. An invitation is a link with a random code, good once, for a
# fortnight; only the code's hash is kept.
#
#   scripts/service.sh invite "Name" [--for WRITER] [--days N]   a link inviting Name (or
#                                                  adding a passkey to WRITER: a new device)
#   scripts/service.sh writers                     who can share, and how much
#   scripts/service.sh disable WRITER | enable WRITER
#   scripts/service.sh usage                       bytes kept, today's counts
#
# On the deployed service (after scripts/deploy.sh); `--local` first works on wrangler
# dev's database instead (SERVICE_PERSIST=dir for another one, SERVICE_ORIGIN for its
# address).
set -euo pipefail
cd "$(dirname "$0")/../service"
W="npx wrangler"
where=(--remote)
origin="$(cat .origin 2>/dev/null || true)"
if [[ "${1:-}" == --local ]]; then
  shift
  where=(--local)
  [[ -n "${SERVICE_PERSIST:-}" ]] && where+=(--persist-to "$SERVICE_PERSIST")
  origin="${SERVICE_ORIGIN:-http://localhost:8788}"
fi
sql() { $W d1 execute volumen "${where[@]}" --json --command "$1" 2>/dev/null; }
q() { printf "%s" "$1" | sed "s/'/''/g"; }
id_ok() { [[ "$1" =~ ^[A-Za-z0-9_-]{22}$ ]] || { echo "not a writer id: $1" >&2; exit 1; }; }

case "${1:-}" in
  invite)
    name="${2:?a name}"; shift 2
    writer="NULL"; days=14
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --for) id_ok "$2"; writer="'$2'"; shift 2 ;;
        --days) [[ "$2" =~ ^[0-9]+$ ]] || exit 1; days="$2"; shift 2 ;;
        *) echo "unknown: $1" >&2; exit 1 ;;
      esac
    done
    code="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
    hash="$(printf %s "$code" | sha256sum | cut -d' ' -f1)"
    now="$(date +%s%3N)"
    sql "INSERT INTO invites (hash, name, writer, created, expires) VALUES ('$hash', '$(q "$name")', $writer, $now, $((now + days * 86400000)))" >/dev/null
    [[ -n "$origin" ]] || origin="https://<the app>"
    echo "$origin/read#invite=$code"
    ;;
  writers)
    sql "SELECT w.id, w.name, w.disabled, datetime(w.created / 1000, 'unixepoch') AS since, (SELECT count(*) FROM passkeys p WHERE p.writer = w.id) AS passkeys, (SELECT count(*) FROM books b WHERE b.writer = w.id) AS books, (SELECT coalesce(sum(size), 0) FROM books b WHERE b.writer = w.id) AS bytes FROM writers w ORDER BY w.created"
    ;;
  disable|enable)
    id_ok "${2:?a writer id}"
    v=$([[ "$1" == disable ]] && echo 1 || echo 0)
    sql "UPDATE writers SET disabled = $v WHERE id = '$2'" >/dev/null
    [[ "$1" == disable ]] && sql "DELETE FROM sessions WHERE writer = '$2'" >/dev/null
    echo "$1d $2"
    ;;
  usage)
    sql "SELECT (SELECT count(*) FROM books) AS books, (SELECT coalesce(sum(size), 0) FROM books) AS book_bytes, (SELECT count(*) FROM notes) AS notes, (SELECT coalesce(sum(size), 0) FROM notes) AS note_bytes, (SELECT group_concat(what || ' ' || n, ', ') FROM counts WHERE day = date('now')) AS today"
    ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
