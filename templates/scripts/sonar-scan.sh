#!/usr/bin/env bash
# Sonar-Scan mit URL und Token aus scripts/.env (siehe .env.example).
# Erkennt .NET-Projekte (dotnet-sonarscanner) und nutzt sonst sonar-scanner bzw. den Scanner-CLI-Container.
set -euo pipefail
set +x # Token darf nie im Trace landen

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# .env ist nur Fallback: bereits gesetzte Umgebungsvariablen (z. B. von der Extension) haben Vorrang
if [ -f "$DIR/.env" ]; then
    while IFS='=' read -r k v || [ -n "$k" ]; do
        v="${v%$'\r'}"
        case "$k" in ''|'#'*|*[!A-Za-z0-9_]*) continue ;; esac
        v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
        if [ -z "${!k:-}" ]; then export "$k=$v"; fi
    done < "$DIR/.env"
fi

: "${SONAR_HOST_URL:?SONAR_HOST_URL fehlt. scripts/.env.example nach scripts/.env kopieren und ausfüllen.}"
: "${SONAR_TOKEN:?SONAR_TOKEN fehlt. scripts/.env.example nach scripts/.env kopieren und ausfüllen.}"

# Key/Organisation: .env > sonar-project.properties > Ordnername
prop() { sed -n "s/^$1=//p" "$ROOT/sonar-project.properties" 2>/dev/null | head -n1 || true; }
KEY="${SONAR_PROJECT_KEY:-$(prop sonar.projectKey)}"
KEY="${KEY:-$(basename "$ROOT")}"
SONAR_ORGANIZATION="${SONAR_ORGANIZATION:-$(prop sonar.organization)}"
EXCL="${SONAR_EXCLUSIONS:-**/node_modules/**,**/bin/**,**/obj/**,**/dist/**,**/coverage/**,**/.git/**,**/.prepush/**}"

cd "$ROOT"
echo "Sonar-Scan: $KEY @ $SONAR_HOST_URL"

SLN="$(find . -maxdepth 1 \( -name '*.sln' -o -name '*.slnx' \) | head -n1)"

if [ -n "$SLN" ]; then
    SCANNER="$(command -v dotnet-sonarscanner || echo "$HOME/.dotnet/tools/dotnet-sonarscanner")"
    [ -x "$SCANNER" ] || { echo "dotnet-sonarscanner fehlt: dotnet tool install --global dotnet-sonarscanner" >&2; exit 1; }
    BEGIN=(/k:"$KEY" /d:sonar.host.url="$SONAR_HOST_URL" /d:sonar.token="$SONAR_TOKEN" /d:sonar.exclusions="$EXCL"
           /d:sonar.cs.opencover.reportsPaths="**/coverage.opencover.xml"
           /d:sonar.qualitygate.wait=true /d:sonar.qualitygate.timeout=300)
    [ -n "${SONAR_ORGANIZATION:-}" ] && BEGIN+=(/o:"$SONAR_ORGANIZATION")
    "$SCANNER" begin "${BEGIN[@]}"
    dotnet build "$SLN" --no-incremental
    dotnet test "$SLN" --no-build --collect:"XPlat Code Coverage" \
        -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=opencover || true
    "$SCANNER" end /d:sonar.token="$SONAR_TOKEN"
else
    ARGS=(-Dsonar.host.url="$SONAR_HOST_URL" -Dsonar.token="$SONAR_TOKEN" -Dsonar.projectKey="$KEY"
          -Dsonar.exclusions="$EXCL" -Dsonar.qualitygate.wait=true -Dsonar.qualitygate.timeout=300)
    [ -n "${SONAR_ORGANIZATION:-}" ] && ARGS+=(-Dsonar.organization="$SONAR_ORGANIZATION")
    if command -v sonar-scanner >/dev/null; then
        sonar-scanner "${ARGS[@]}"
    elif command -v docker >/dev/null; then
        docker run --rm --network host --user "$(id -u):$(id -g)" -v "$ROOT:/usr/src" \
            sonarsource/sonar-scanner-cli "${ARGS[@]}"
    else
        echo "Weder sonar-scanner noch docker gefunden." >&2
        exit 1
    fi
fi

echo "##prepush[link] ${SONAR_HOST_URL%/}/dashboard?id=$KEY"
