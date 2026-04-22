#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${FLOW_AZURE_APP_DIR:-/home/site/wwwroot}"
EXTRACT_DIR="${APP_DIR}/.node_modules_extract"
MODULES_DIR="${APP_DIR}/node_modules"
MODULES_TARBALL="${APP_DIR}/node_modules.tar.gz"
LOG_DIR="${FLOW_AZURE_LOG_DIR:-/home/LogFiles}"
LOG_FILE="${LOG_DIR}/flow-azure-startup.log"

mkdir -p "${LOG_DIR}"
exec >>"${LOG_FILE}" 2>&1

log() {
  printf '[flow-azure-startup] %s\n' "$*"
}

extract_node_modules_if_needed() {
  if [[ -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "Runtime dependencies already available."
    return 0
  fi

  if [[ ! -f "${MODULES_TARBALL}" ]]; then
    log "node_modules.tar.gz is missing and fastify is unavailable."
    return 1
  fi

  cd "${APP_DIR}"

  if [[ -L "${MODULES_DIR}" ]]; then
    rm -f "${MODULES_DIR}"
  fi

  rm -rf "${MODULES_DIR}" "${EXTRACT_DIR}"
  mkdir -p "${MODULES_DIR}" "${EXTRACT_DIR}"

  log "Extracting runtime dependencies from node_modules.tar.gz."
  tar -xzf "${MODULES_TARBALL}" -C "${EXTRACT_DIR}"

  local source_dir="${EXTRACT_DIR}"
  if [[ -d "${EXTRACT_DIR}/package/node_modules" ]]; then
    source_dir="${EXTRACT_DIR}/package/node_modules"
  elif [[ -d "${EXTRACT_DIR}/node_modules" ]]; then
    source_dir="${EXTRACT_DIR}/node_modules"
  fi

  if [[ -z "$(find "${source_dir}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    log "Extraction completed but no dependency directories were found."
    return 1
  fi

  cp -a "${source_dir}/." "${MODULES_DIR}/"

  rm -rf "${EXTRACT_DIR}"

  if [[ ! -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "fastify is still missing after extracting node_modules.tar.gz."
    return 1
  fi
}

cd "${APP_DIR}"
log "Startup wrapper invoked at $(date -u +%FT%TZ)."
log "cwd=$(pwd)"
log "node=$(node -v 2>/dev/null || echo missing)"
log "NODE_ENV=${NODE_ENV:-} AUTH_MODE=${AUTH_MODE:-} AUTH_ALLOW_DEV_HEADERS=${AUTH_ALLOW_DEV_HEADERS:-} AUTH_ALLOW_IMPLICIT_ADMIN=${AUTH_ALLOW_IMPLICIT_ADMIN:-} ENTRA_STRICT_MODE=${ENTRA_STRICT_MODE:-} PORT=${PORT:-}"
log "node_modules=$(ls -ld "${MODULES_DIR}" 2>/dev/null || echo missing)"
log "root_node_modules=$(ls -ld /node_modules 2>/dev/null || echo missing)"
node --input-type=module <<'EOF'
import { env } from "./dist/lib/env.js";

console.log(
  `[flow-azure-startup] parsed AUTH_ALLOW_DEV_HEADERS raw=${JSON.stringify(process.env.AUTH_ALLOW_DEV_HEADERS ?? null)} value=${String(env.AUTH_ALLOW_DEV_HEADERS)}`,
);
console.log(
  `[flow-azure-startup] parsed AUTH_ALLOW_IMPLICIT_ADMIN raw=${JSON.stringify(process.env.AUTH_ALLOW_IMPLICIT_ADMIN ?? null)} value=${String(env.AUTH_ALLOW_IMPLICIT_ADMIN)}`,
);
console.log(
  `[flow-azure-startup] parsed ENTRA_STRICT_MODE raw=${JSON.stringify(process.env.ENTRA_STRICT_MODE ?? null)} value=${String(env.ENTRA_STRICT_MODE)}`,
);
EOF
extract_node_modules_if_needed

log "Starting Flow backend."
exec node dist/server.js
