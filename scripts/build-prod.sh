#!/bin/bash
set -e

echo "=== Build: API Server ==="
pnpm --filter @workspace/api-server run build

echo "=== Build: Dashboard ==="
pnpm --filter @workspace/gateway-dashboard run build

echo "=== Build complete ==="
