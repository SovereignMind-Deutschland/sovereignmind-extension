#!/usr/bin/env bash
# Prepush-Check. Die Extension "360Volt Prepush" führt dieses Script per Play-Button aus.
# Schritte mit Markern ausgeben (##prepush[step:...]), dann erscheinen sie im Log/Report.
# Dieses Script ist eine Vorlage: Schritte an das jeweilige Repo anpassen.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

step() {
    local name="$1"; shift
    echo "##prepush[step:start] $name"
    if "$@"; then
        echo "##prepush[step:ok] $name"
    else
        echo "##prepush[step:fail] $name"
        exit 1
    fi
}

# --- Repo-spezifisch ---
if [ -f package.json ]; then
    step install npm ci
    step build npm run build
    step test npm test --if-present
fi

# --- Sonar (URL + Token aus scripts/.env) ---
step sonar scripts/sonar-scan.sh
