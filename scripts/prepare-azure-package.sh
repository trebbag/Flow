#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE_PATH:?PACKAGE_PATH is required}"
: "${PACKAGE_ZIP_PATH:?PACKAGE_ZIP_PATH is required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

rm -rf "${PACKAGE_PATH}"
mkdir -p "${PACKAGE_PATH}"

cp scripts/azure-startup.sh "${PACKAGE_PATH}/azure-startup.sh"
cp -R dist "${PACKAGE_PATH}/dist"
cp -R generated "${PACKAGE_PATH}/generated"
cp -R prisma "${PACKAGE_PATH}/prisma"

node --input-type=module > "${PACKAGE_PATH}/package.json" <<'NODE'
import fs from "node:fs";

const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
const azureRuntimeDependencies = [
  "@azure/identity",
  "@fastify/cors",
  "@fastify/helmet",
  "@fastify/rate-limit",
  "@prisma/adapter-pg",
  "@prisma/client",
  "csv-parse",
  "dotenv",
  "fastify",
  "jose",
  "luxon",
  "pg",
  "zod",
];

const dependencies = {};
for (const name of azureRuntimeDependencies) {
  const version = rootPackage.dependencies?.[name];
  if (!version) {
    throw new Error(`Missing Azure runtime dependency in root package.json: ${name}`);
  }
  dependencies[name] = version;
}

process.stdout.write(`${JSON.stringify({
  name: "flow-backend-azure-runtime",
  private: true,
  type: "module",
  dependencies,
}, null, 2)}\n`);
NODE

(
  cd "${PACKAGE_PATH}"
  npm install --omit=dev --no-package-lock --ignore-scripts --no-audit --no-fund
)

PRISMA_CLIENT_DIR="$(node -e "const fs = require('fs'); const path = require('path'); const { createRequire } = require('module'); const req = createRequire(process.cwd() + '/'); const pkg = req.resolve('@prisma/client/package.json', { paths: [process.cwd()] }); process.stdout.write(fs.realpathSync(path.dirname(pkg)));")"
GENERATED_PRISMA_DIR="$(node -e "const fs = require('fs'); const path = require('path'); const { createRequire } = require('module'); const req = createRequire(process.cwd() + '/'); const pkg = req.resolve('@prisma/client/package.json', { paths: [process.cwd()] }); const clientDir = fs.realpathSync(path.dirname(pkg)); process.stdout.write(path.resolve(clientDir, '..', '..', '.prisma'));")"

if [[ ! -d "${PRISMA_CLIENT_DIR}" ]]; then
  echo "Resolved Prisma client directory not found: ${PRISMA_CLIENT_DIR}" >&2
  exit 1
fi

if [[ ! -d "${GENERATED_PRISMA_DIR}" ]]; then
  echo "Resolved generated Prisma directory not found: ${GENERATED_PRISMA_DIR}" >&2
  exit 1
fi

rm -rf "${PACKAGE_PATH}/node_modules/@prisma/client" "${PACKAGE_PATH}/node_modules/.prisma"
mkdir -p "${PACKAGE_PATH}/node_modules/@prisma"
cp -RL "${PRISMA_CLIENT_DIR}" "${PACKAGE_PATH}/node_modules/@prisma/client"
cp -RL "${GENERATED_PRISMA_DIR}" "${PACKAGE_PATH}/node_modules/.prisma"

python3 scripts/create-clean-zip.py "${PACKAGE_PATH}" "${PACKAGE_ZIP_PATH}"
