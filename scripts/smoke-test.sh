#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ROADFUN_ADMIN_PASSWORD='roadfun-test-admin-password-is-long'
export ROADFUN_INVITE_CODE='roadfun-ci-test-invite-secret'
export ROADFUN_DATA_DIR
ROADFUN_DATA_DIR="$(mktemp -d)"
PORT=59117
export ROADFUN_ROUTING_URL="http://127.0.0.1:59118"
python3 scripts/mock-routing.py >"$ROADFUN_DATA_DIR/osrm.log" 2>&1 &
MOCK_PID=$!
ASPNETCORE_URLS="http://127.0.0.1:$PORT" dotnet run --no-launch-profile -c Release --no-build --project src/RoadFun.Api/RoadFun.Api.csproj >"$ROADFUN_DATA_DIR/server.log" 2>&1 &
PID=$!
cleanup() { kill "$PID" "$MOCK_PID" 2>/dev/null || true; wait "$PID" "$MOCK_PID" 2>/dev/null || true; cat "$ROADFUN_DATA_DIR/server.log"; cat "$ROADFUN_DATA_DIR/osrm.log"; rm -rf "$ROADFUN_DATA_DIR"; }
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
TRACK_ID=$(curl --silent --show-error --fail -H "$AUTH" "$BASE/tracks" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
# Route guidance must be parsed from OSRM maneuver steps (mocked locally; no external network).
curl --silent --show-error --fail -H "$AUTH" "$BASE/route?fromLat=48.2&fromLon=13.5&toLat=48.21&toLon=13.51&mode=fun" | \
    python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["alternatives"]==2; assert len(r["steps"])==3; assert r["steps"][1]["type"]=="turn"; assert len(r["geometry"])>=3'
# Exercise invitations, friend approvals, chat, meet creation and admin login.
CODE2=$(curl --silent --show-error --fail -H 'Content-Type: application/json' -d '{"username":"friend","password":"a-very-long-test-password","inviteCode":"roadfun-ci-test-invite-secret"}' "$BASE/auth/register")
TOKEN2=$(printf '%s' "$CODE2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
AUTH2="Authorization: Bearer $TOKEN2"
FRIEND_CODE=$(curl --silent --show-error --fail -H "$AUTH2" "$BASE/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')
test "$(curl --silent --show-error --fail -H "$AUTH2" "$BASE/map/people")" = '[]'
test "$(curl --silent --show-error --fail -H "$AUTH2" "$BASE/tracks")" = '[]'
# Private tracks cannot be used as run targets by other users.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH2" -H 'Content-Type: application/json' \
  -d "{\"trackId\":\"$TRACK_ID\",\"durationSeconds\":25,\"distanceKm\":0.3,\"maxKmh\":38,\"avgKmh\":30,\"maxG\":0.1}" "$BASE/runs")
test "$STATUS" = "403"
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"trackId\":\"$TRACK_ID\",\"durationSeconds\":25,\"distanceKm\":0.3,\"maxKmh\":38,\"avgKmh\":30,\"maxG\":0.1}" "$BASE/runs" >/dev/null
curl --silent --show-error --fail -H "$AUTH" "$BASE/runs" | grep -q 'Track 1'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d "{\"code\":\"$FRIEND_CODE\"}" "$BASE/friends/request" >/dev/null
REQUEST_ID=$(curl --silent --show-error --fail -H "$AUTH2" "$BASE/friends" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["requestId"])')
curl --silent --show-error --fail -H "$AUTH2" -X POST "$BASE/friends/$REQUEST_ID/accept" >/dev/null
curl --silent --show-error --fail -H "$AUTH2" "$BASE/map/people" | grep -q '"username":"tester"'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -X PATCH -d '{"shareLocation":false}' "$BASE/me" >/dev/null
test "$(curl --silent --show-error --fail -H "$AUTH2" "$BASE/map/people")" = '[]'
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d '{"body":"Hello from smoke test"}' "$BASE/messages/$FRIEND_CODE" >/dev/null
USER_CODE=$(curl --silent --show-error --fail -H "$AUTH" "$BASE/me" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')
curl --silent --show-error --fail -H "$AUTH2" "$BASE/messages/$USER_CODE" | grep -q 'Hello from smoke test'
MEET_DATE="$(date -u -d '+2 days' +'%Y-%m-%dT%H:%M:%SZ')"
curl --silent --show-error --fail -H "$AUTH" -H 'Content-Type: application/json' -d "{\"title\":\"Smoke Meet\",\"lat\":48.2,\"lon\":13.5,\"startsAt\":\"$MEET_DATE\",\"description\":\"Test\"}" "$BASE/meets" >/dev/null
# Admin name/password are configurable rather than using the insecure PLANS.md default.
curl --silent --show-error --fail -H 'Content-Type: application/json' -d '{"username":"Admin","password":"roadfun-test-admin-password-is-long"}' "$BASE/auth/login" | grep -q 'token'
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/me")
test "$STATUS" = "401"
echo "RoadFun smoke test PASSED"
