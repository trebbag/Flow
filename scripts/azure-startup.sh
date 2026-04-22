#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${FLOW_AZURE_APP_DIR:-/home/site/wwwroot}"
EXTRACT_DIR="${APP_DIR}/.node_modules_extract"
MODULES_DIR="${APP_DIR}/node_modules"
MODULES_TARBALL="${APP_DIR}/node_modules.tar.gz"

log() {
  printf '[flow-azure-startup] %s\n' "$*"
}

extract_node_modules_if_needed() {
  if [[ -f "${MODULES_DIR}/fastify/package.json" ]]; then
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

  shopt -s dotglob nullglob
  local extracted_entries=("${source_dir}"/*)
  if (( ${#extracted_entries[@]} == 0 )); then
    log "Extraction completed but no dependency directories were found."
    return 1
  fi
  mv "${extracted_entries[@]}" "${MODULES_DIR}/"
  shopt -u dotglob nullglob

  rm -rf "${EXTRACT_DIR}"

  if [[ ! -f "${MODULES_DIR}/fastify/package.json" ]]; then
    log "fastify is still missing after extracting node_modules.tar.gz."
    return 1
  fi
}

cd "${APP_DIR}"
extract_node_modules_if_needed

log "Starting Flow backend."
exec node dist/server.js
