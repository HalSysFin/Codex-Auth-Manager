#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ensure_node_deps() {
  local package_dir="$1"
  if [ ! -d "$package_dir/node_modules" ]; then
    echo "Installing test dependencies for $package_dir"
    npm --prefix "$package_dir" install --no-package-lock >/dev/null
  fi
}

echo "Running Auth Manager broker lifecycle test suite"

if python3 -m unittest tests.test_lease_broker_store; then
  echo "Backend broker tests passed in local Python environment"
elif docker ps --format '{{.Names}}' | grep -qx 'auth_manager-auth-manager-1'; then
  echo "Local Python backend deps unavailable, falling back to auth_manager-auth-manager-1"
  docker exec auth_manager-auth-manager-1 python -m unittest tests.test_lease_broker_store
else
  echo "Backend broker tests failed locally and auth_manager-auth-manager-1 is not running" >&2
  exit 1
fi

ensure_node_deps "packages/lease-runtime"
ensure_node_deps "vscode-extension"
ensure_node_deps "desktop-app"
ensure_node_deps "headless-client"
ensure_node_deps "openclaw-plugin"

npm --prefix packages/lease-runtime test
npm --prefix vscode-extension test
npm --prefix desktop-app test
npm --prefix headless-client test
npm --prefix openclaw-plugin test

echo "Broker lifecycle test suite completed successfully"
