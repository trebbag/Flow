#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${FLOW_AZURE_APP_DIR:-/home/site/wwwroot}"
EXTRACT_ROOT="${APP_DIR}/.node_modules_extracts"
LOCK_DIR="${APP_DIR}/.node_modules_lock"
MODULES_DIR="${APP_DIR}/node_modules"
MODULES_TARBALL="${APP_DIR}/node_modules.tar.gz"
LOG_DIR="${FLOW_AZURE_LOG_DIR:-/home/LogFiles}"
LOG_FILE="${LOG_DIR}/flow-azure-startup.log"

mkdir -p "${LOG_DIR}"
exec >>"${LOG_FILE}" 2>&1

log() {
  printf '[flow-azure-startup] %s\n' "$*"
}

resolve_extracted_source_dir() {
  local extract_dir="$1"

  if [[ -d "${extract_dir}/package/node_modules" ]]; then
    printf '%s\n' "${extract_dir}/package/node_modules"
    return 0
  fi

  if [[ -d "${extract_dir}/node_modules" ]]; then
    printf '%s\n' "${extract_dir}/node_modules"
    return 0
  fi

  if [[ -d "${extract_dir}" ]]; then
    printf '%s\n' "${extract_dir}"
    return 0
  fi

  return 1
}

is_runtime_dependency_tree_ready() {
  local source_dir="$1"
  [[ -f "${source_dir}/fastify/package.json" ]] && [[ -f "${source_dir}/dotenv/package.json" ]]
}

promote_dependency_tree() {
  local source_dir="$1"

  rm -rf "${MODULES_DIR}"
  ln -s "${source_dir}" "${MODULES_DIR}"
  log "Promoted runtime dependencies via symlink: ${MODULES_DIR} -> ${source_dir}"
}

promote_extracted_node_modules_if_available() {
  local extract_dir
  local source_dir

  mkdir -p "${EXTRACT_ROOT}"

  while IFS= read -r extract_dir; do
    source_dir="$(resolve_extracted_source_dir "${extract_dir}")" || continue
    if ! is_runtime_dependency_tree_ready "${source_dir}"; then
      continue
    fi

    promote_dependency_tree "${source_dir}"
    log "Reused extracted runtime dependencies from ${extract_dir}."
    return 0
  done < <(find "${EXTRACT_ROOT}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -r)

  return 1
}

with_dependency_lock() {
  local attempt=0

  while ! mkdir "${LOCK_DIR}" 2>/dev/null; do
    attempt=$((attempt + 1))
    if (( attempt > 60 )); then
      log "Timed out waiting for dependency extraction lock."
      return 1
    fi
    sleep 1
  done

  trap 'rm -rf "${LOCK_DIR}"' RETURN
  "$@"
}

extract_node_modules_into_fresh_dir() {
  local extract_dir
  local source_dir

  mkdir -p "${EXTRACT_ROOT}"
  extract_dir="$(mktemp -d "${EXTRACT_ROOT}/extract.XXXXXX")"

  log "Extracting runtime dependencies into ${extract_dir}."
  COPYFILE_DISABLE=1 tar -xzf "${MODULES_TARBALL}" -C "${extract_dir}"

  source_dir="$(resolve_extracted_source_dir "${extract_dir}")" || {
    log "Extraction completed but no dependency directories were found."
    return 1
  }

  if ! is_runtime_dependency_tree_ready "${source_dir}"; then
    log "Runtime dependency tree is incomplete after extraction."
    return 1
  fi

  promote_dependency_tree "${source_dir}"
}

extract_node_modules_under_lock() {
  if [[ -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "Runtime dependencies became available while waiting for extraction lock."
    return 0
  fi

  if promote_extracted_node_modules_if_available; then
    return 0
  fi

  extract_node_modules_into_fresh_dir
}

extract_node_modules_if_needed() {
  if [[ -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "Runtime dependencies already available."
    return 0
  fi

  if promote_extracted_node_modules_if_available; then
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

  with_dependency_lock extract_node_modules_under_lock

  if [[ ! -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "fastify is still missing after dependency preparation."
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
extract_node_modules_if_needed

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

log "Starting Flow backend."
exec node dist/server.js
