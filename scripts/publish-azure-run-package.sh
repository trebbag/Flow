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
slot_suffix=""
if [[ -n "${AZURE_SLOT:-}" ]]; then
  slot_args=(--slot "${AZURE_SLOT}")
  slot_suffix="-${AZURE_SLOT}"
fi

sanitize_storage_name() {
  local raw="$1"
  local sanitized
  sanitized="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  sanitized="${sanitized:0:24}"
  if [[ ${#sanitized} -lt 3 ]]; then
    sanitized="flowpkg${sanitized}"
    sanitized="${sanitized:0:24}"
  fi
  printf '%s' "${sanitized}"
}

webapp_json="$(az webapp show \
  --name "${AZURE_WEBAPP_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  "${slot_args[@]}" \
  -o json)"

subscription_id="$(az account show --query id -o tsv)"
subscription_suffix="$(sanitize_storage_name "${subscription_id}")"
subscription_suffix="${subscription_suffix:0:8}"

location="$(jq -r '.location // empty' <<<"${webapp_json}")"
if [[ -z "${location}" ]]; then
  echo "Unable to resolve Azure location for ${AZURE_WEBAPP_NAME}${slot_suffix}" >&2
  exit 1
fi

default_storage_prefix="$(sanitize_storage_name "${AZURE_WEBAPP_NAME}")"
default_storage_prefix="${default_storage_prefix:0:$((24 - ${#subscription_suffix}))}"
storage_account="${AZURE_PACKAGE_STORAGE_ACCOUNT:-${default_storage_prefix}${subscription_suffix}}"
storage_account="$(sanitize_storage_name "${storage_account}")"
container_name="${AZURE_PACKAGE_CONTAINER:-app-packages}"
package_sas_days="${AZURE_PACKAGE_SAS_DAYS:-14}"

if ! az storage account show \
  --name "${storage_account}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --only-show-errors \
  -o none 2>/dev/null; then
  echo "Creating private package storage account ${storage_account} in ${AZURE_RESOURCE_GROUP}."
  az storage account create \
    --name "${storage_account}" \
    --resource-group "${AZURE_RESOURCE_GROUP}" \
    --location "${location}" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --https-only true \
    --allow-blob-public-access false \
    --min-tls-version TLS1_2 \
    --only-show-errors \
    -o none
fi

storage_key="$(az storage account keys list \
  --account-name "${storage_account}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --query '[0].value' \
  -o tsv)"

if [[ -z "${storage_key}" ]]; then
  echo "Unable to resolve storage key for ${storage_account}" >&2
  exit 1
fi

az storage container create \
  --account-name "${storage_account}" \
  --account-key "${storage_key}" \
  --name "${container_name}" \
  --public-access off \
  --only-show-errors \
  -o none

sha_part="${GITHUB_SHA:-manual}"
sha_part="${sha_part:0:12}"
timestamp="$(date -u +%Y%m%d%H%M%S)"
blob_name="${AZURE_WEBAPP_NAME}${slot_suffix}/${sha_part}-${timestamp}.zip"

az storage blob upload \
  --account-name "${storage_account}" \
  --account-key "${storage_key}" \
  --container-name "${container_name}" \
  --name "${blob_name}" \
  --file "${PACKAGE_ZIP_PATH}" \
  --overwrite true \
  --only-show-errors \
  -o none

if expiry="$(date -u -d "+${package_sas_days} days" '+%Y-%m-%dT%H:%MZ' 2>/dev/null)"; then
  :
elif expiry="$(date -u -v+"${package_sas_days}"d '+%Y-%m-%dT%H:%MZ' 2>/dev/null)"; then
  :
else
  echo "Unable to compute package SAS expiry" >&2
  exit 1
fi

sas_token="$(az storage blob generate-sas \
  --account-name "${storage_account}" \
  --account-key "${storage_key}" \
  --container-name "${container_name}" \
  --name "${blob_name}" \
  --permissions r \
  --expiry "${expiry}" \
  --https-only \
  -o tsv)"

if [[ -z "${sas_token}" ]]; then
  echo "Unable to generate package SAS token" >&2
  exit 1
fi

package_url="https://${storage_account}.blob.core.windows.net/${container_name}/${blob_name}?${sas_token}"

az webapp config appsettings set \
  --name "${AZURE_WEBAPP_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  "${slot_args[@]}" \
  --settings \
    WEBSITE_RUN_FROM_PACKAGE="${package_url}" \
    SCM_DO_BUILD_DURING_DEPLOYMENT=false \
    ENABLE_ORYX_BUILD=false \
    WEBSITES_CONTAINER_START_TIME_LIMIT=1800 \
  --only-show-errors \
  -o none

az webapp config set \
  --name "${AZURE_WEBAPP_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  "${slot_args[@]}" \
  --startup-file "bash /home/site/wwwroot/azure-startup.sh" \
  --only-show-errors \
  -o none

az webapp restart \
  --name "${AZURE_WEBAPP_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  "${slot_args[@]}" \
  --only-show-errors \
  -o none

echo "Published Run-From-Package artifact ${blob_name} to ${storage_account}/${container_name} and restarted ${AZURE_WEBAPP_NAME}${slot_suffix}."
