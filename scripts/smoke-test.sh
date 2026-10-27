#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ROADFUN_ADMIN_PASSWORD='roadfun-test-admin-password-is-long'
export ROADFUN_INVITE_CODE='roadfun-ci-test-invite-secret'
export ROADFUN_DATA_DIR
ROADFUN_DATA_DIR="$(mktemp -d)"
PORT=59117
ASPNETCORE_URLS="http://127.0.0.1:$PORT" dotnet run --no-launch-profile -c Release --no-build --project src/RoadFun.Api/RoadFun.Api.csproj >"$ROADFUN_DATA_DIR/server.log" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; cat "$ROADFUN_DATA_DIR/server.log"; rm -rf "$ROADFUN_DATA_DIR"; }
trap cleanup EXIT
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:$PORT/api/health" >/dev/null; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "API process exited"; exit 1; fi
  sleep 1
done
BASE="http://127.0.0.1:$PORT/api"
curl --silent --fail "$BASE/health" | grep -q '"ok"'
CODE=$(curl --silent --show-error --fail -H 'Content-Type: application/json' -d '{"username":"tester","password":"correct-horse-battery-123","inviteCode":"roadfun-ci-test-invite-secret"}' "$BASE/auth/register")
TOKEN=$(printf '%s' "$CODE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
AUTH="Authorization: Bearer $TOKEN"
curl --silent --show-error --fail -H "$AUTH" "$BASE/me" | grep -q 'tester'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -X PATCH -d '{"car":"Test Vehicle","shareLocation":true}' "$BASE/me" | grep -q 'Test Vehicle'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d '{"lat":48.2,"lon":13.5,"accuracy":6}' "$BASE/location" >/dev/null
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d '{"kind":"hazard","lat":48.2,"lon":13.5,"note":"Smoke test"}' "$BASE/reports" >/dev/null
curl --silent --show-error --fail -H "$AUTH" "$BASE/reports" | grep -q 'Smoke test'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d '{"title":"Track 1","startLat":48.2,"startLon":13.5,"endLat":48.21,"endLon":13.51,"visibility":"private"}' "$BASE/tracks" >/dev/null
curl --silent --show-error --fail -H "$AUTH" "$BASE/tracks" | grep -q 'Track 1'
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/me")
test "$STATUS" = "401"
echo "RoadFun smoke test PASSED"
