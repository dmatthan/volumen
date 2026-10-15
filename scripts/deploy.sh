#!/usr/bin/env bash
# Volumen on Cloudflare: the web app and its sharing service, one Worker (service/,
# docs/PLAN.md M2) at its custom domain (service/wrangler.jsonc routes), else at
# https://volumen.<your subdomain>.workers.dev.
#
#   npx wrangler login         once (opens Cloudflare in the browser)
#   scripts/deploy.sh          checks, makes what is missing, builds, deploys
#
# The first run makes the D1 database (and writes its id into service/wrangler.jsonc)
# and applies the schema; later runs apply new migrations. Writers' invitations and
# readers' notes need Turnstile: until its site key is in service/wrangler.jsonc (vars)
# and its secret is set (`cd service && npx wrangler secret put TURNSTILE_SECRET`), the
# service refuses them and says so; reading shared books works without it.
#
# Nothing it makes can be billed on the Workers Free plan: requests past the free
# allowance are refused, D1 refuses work past its limits, static assets are free, and
# no paid product (R2, KV writes past free, Durable Objects) is used.
set -euo pipefail
cd "$(dirname "$0")/../service"
W="npx wrangler"
[[ -d node_modules ]] || npm install --no-audit --no-fund

$W whoami >/dev/null 2>&1 || { echo "Not signed in to Cloudflare: run  npx wrangler login  first." >&2; exit 1; }

# the database: made once, its id kept in the config
if grep -q '"database_id": "00000000-0000-0000-0000-000000000000"' wrangler.jsonc; then
  id="$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name==="volumen");process.stdout.write(d?d.uuid:"")})')"
  if [[ -z "$id" ]]; then
    $W d1 create volumen >/dev/null
    id="$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).find(x=>x.name==="volumen").uuid))')"
  fi
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { echo "Could not find the D1 database's id." >&2; exit 1; }
  sed -i "s/\"database_id\": \"00000000-0000-0000-0000-000000000000\"/\"database_id\": \"$id\"/" wrangler.jsonc
  echo "D1 database volumen: $id (kept in service/wrangler.jsonc)"
fi
$W d1 migrations apply volumen --remote

npm --prefix ../app run check
(cd ../app && VOLUMEN_WEB=1 npx vite build --outDir dist-web --emptyOutDir --logLevel warn)
npx wrangler types >/dev/null && npx tsc --noEmit -p .

out="$($W deploy 2>&1 | tee /dev/stderr)"
# the custom domain if there is one, else workers.dev
domain="$(grep -oP '"pattern": "\K[^"]+(?=", "custom_domain": true)' wrangler.jsonc | head -1 || true)"
url="${domain:+https://$domain}"
[[ -n "$url" ]] || url="$(grep -o 'https://[a-z0-9.-]*\.workers\.dev' <<<"$out" | head -1 || true)"
[[ -n "$url" ]] && echo "$url" > .origin && echo "Live at $url"

grep -q '"TURNSTILE_SITEKEY": ""' wrangler.jsonc && echo "
Turnstile is not set up yet, so invitations and readers' notes are refused for now:
  1. Cloudflare dashboard → Turnstile → Add widget: hostname ${url#https://}, mode Managed.
  2. Put its site key in service/wrangler.jsonc (vars.TURNSTILE_SITEKEY).
  3. cd service && npx wrangler secret put TURNSTILE_SECRET   (its secret key)
  4. scripts/deploy.sh again."
exit 0
