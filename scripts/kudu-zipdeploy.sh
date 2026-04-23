#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_WEBAPP_NAME:?AZURE_WEBAPP_NAME is required}"
: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${PACKAGE_ZIP_PATH:?PACKAGE_ZIP_PATH is required}"

if [[ ! -f "${PACKAGE_ZIP_PATH}" ]]; then
  echo "Deployment package not found: ${PACKAGE_ZIP_PATH}" >&2
  exit 1
fi

slot_args=()
if [[ -n "${AZURE_SLOT:-}" ]]; then
  slot_args=(--slot "${AZURE_SLOT}")
fi

credentials_json="$(az webapp deployment list-publishing-credentials \
  --name "${AZURE_WEBAPP_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  "${slot_args[@]}" \
  -o json)"

publishing_user="$(jq -r '.publishingUserName // empty' <<<"${credentials_json}")"
publishing_password="$(jq -r '.publishingPassword // empty' <<<"${credentials_json}")"
scm_uri="$(jq -r '.scmUri // empty' <<<"${credentials_json}")"

if [[ -z "${publishing_user}" || -z "${publishing_password}" || -z "${scm_uri}" ]]; then
  echo "Unable to resolve Kudu publishing credentials for ${AZURE_WEBAPP_NAME}" >&2
  exit 1
fi

zipdeploy_url="${scm_uri%/}/api/zipdeploy?isAsync=true&clean=true"

headers_file=""
body_file=""
http_code=""
for attempt in {1..12}; do
  rm -f "${headers_file:-}" "${body_file:-}"
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  http_code="$(curl -sS \
    -D "${headers_file}" \
    -o "${body_file}" \
    -w "%{http_code}" \
    -u "${publishing_user}:${publishing_password}" \
    -H "Content-Type: application/zip" \
    --data-binary @"${PACKAGE_ZIP_PATH}" \
    "${zipdeploy_url}")"

  if [[ "${http_code}" == "200" || "${http_code}" == "202" ]]; then
    break
  fi

  if [[ "${http_code}" == "409" && "${attempt}" != "12" ]]; then
    echo "Kudu deployment is already in progress; retrying ZipDeploy submission (${attempt}/12)."
    sleep 30
    continue
  fi

  echo "Kudu ZipDeploy submission failed with HTTP ${http_code}" >&2
  cat "${body_file}" >&2
  exit 1
done

trap 'rm -f "${headers_file:-}" "${body_file:-}"' EXIT

deployment_status_url="$(awk 'BEGIN { IGNORECASE=1 } /^Location:/ { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print; exit }' "${headers_file}")"

echo "Kudu ZipDeploy accepted with HTTP ${http_code}."
if [[ -n "${deployment_status_url}" ]]; then
  echo "Deployment status URL: ${deployment_status_url}"
fi
