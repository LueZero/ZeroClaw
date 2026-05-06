#!/bin/sh
SID="$1"
for ep in "/session/$SID" "/session/$SID/message" "/session/$SID/messages" "/session/$SID/history"; do
  echo "=== $ep ==="
  code=$(curl -sS -o /tmp/r.json -w "%{http_code}" "http://localhost:54321$ep")
  echo "HTTP $code"
  head -c 600 /tmp/r.json
  echo
  echo
done
