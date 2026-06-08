#!/bin/bash
# Test SClaw chat API
set -e
echo "=== Login ==="
TOKEN=$(curl -s -X POST http://localhost:3001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"jack","password":"123456"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
echo "Token: ${TOKEN:0:20}..."

echo ""
echo "=== Send Chat ==="
curl -s -N -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"say hello in one short sentence"}' 2>&1 | head -50
echo ""
echo "=== Done ==="
