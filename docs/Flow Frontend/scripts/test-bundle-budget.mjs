import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const assetsDir = path.resolve(process.cwd(), "dist", "assets");

const budget = {
  maxEntryJsGzipKb: Number(process.env.BUNDLE_BUDGET_MAX_ENTRY_JS_GZIP_KB || 125),
  maxAnyJsGzipKb: Number(process.env.BUNDLE_BUDGET_MAX_ANY_JS_GZIP_KB || 125),
  maxAnyCssGzipKb: Number(process.env.BUNDLE_BUDGET_MAX_ANY_CSS_GZIP_KB || 28),
  maxTotalJsGzipKb: Number(process.env.BUNDLE_BUDGET_MAX_TOTAL_JS_GZIP_KB || 430),
  maxTotalCssGzipKb: Number(process.env.BUNDLE_BUDGET_MAX_TOTAL_CSS_GZIP_KB || 35),
};

function toKb(bytes) {
  return Number((bytes / 1024).toFixed(2));
}

function gzipSize(buffer) {
  return zlib.gzipSync(buffer, { level: 9 }).length;
}

function readAssetSizes() {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing build artifacts at ${assetsDir}. Run 'pnpm build' first.`);
  }

  const files = fs.readdirSync(assetsDir);
  const jsFiles = files.filter((file) => file.endsWith(".js"));
  const cssFiles = files.filter((file) => file.endsWith(".css"));

  const js = jsFiles.map((file) => {
    const fullPath = path.join(assetsDir, file);
    const content = fs.readFileSync(fullPath);
    return { file, gzipBytes: gzipSize(content) };
  });

  const css = cssFiles.map((file) => {
    const fullPath = path.join(assetsDir, file);
    const content = fs.readFileSync(fullPath);
    return { file, gzipBytes: gzipSize(content) };
  });

  const entryCandidates = js.filter((asset) => /^index-.*\.js$/i.test(asset.file));
  const entry = entryCandidates.sort((a, b) => b.gzipBytes - a.gzipBytes)[0] || null;
  const largestJs = js.sort((a, b) => b.gzipBytes - a.gzipBytes)[0] || null;
  const largestCss = css.sort((a, b) => b.gzipBytes - a.gzipBytes)[0] || null;
  const totalJsGzipBytes = js.reduce((sum, asset) => sum + asset.gzipBytes, 0);
  const totalCssGzipBytes = css.reduce((sum, asset) => sum + asset.gzipBytes, 0);

  return {
    entry,
    largestJs,
    largestCss,
    totalJsGzipBytes,
    totalCssGzipBytes,
  };
}

function main() {
  const sizes = readAssetSizes();
  const failures = [];

  const entryKb = toKb(sizes.entry?.gzipBytes || 0);
  const largestJsKb = toKb(sizes.largestJs?.gzipBytes || 0);
  const largestCssKb = toKb(sizes.largestCss?.gzipBytes || 0);
  const totalJsKb = toKb(sizes.totalJsGzipBytes);
  const totalCssKb = toKb(sizes.totalCssGzipBytes);

  if (entryKb > budget.maxEntryJsGzipKb) {
    failures.push(
      `Entry JS gzip exceeds budget: ${entryKb}KB > ${budget.maxEntryJsGzipKb}KB (${sizes.entry?.file || "none"})`,
    );
  }

  if (largestJsKb > budget.maxAnyJsGzipKb) {
    failures.push(
      `Largest JS chunk gzip exceeds budget: ${largestJsKb}KB > ${budget.maxAnyJsGzipKb}KB (${sizes.largestJs?.file || "none"})`,
    );
  }

  if (largestCssKb > budget.maxAnyCssGzipKb) {
    failures.push(
      `Largest CSS chunk gzip exceeds budget: ${largestCssKb}KB > ${budget.maxAnyCssGzipKb}KB (${sizes.largestCss?.file || "none"})`,
    );
  }

  if (totalJsKb > budget.maxTotalJsGzipKb) {
    failures.push(`Total JS gzip exceeds budget: ${totalJsKb}KB > ${budget.maxTotalJsGzipKb}KB`);
  }

  if (totalCssKb > budget.maxTotalCssGzipKb) {
    failures.push(`Total CSS gzip exceeds budget: ${totalCssKb}KB > ${budget.maxTotalCssGzipKb}KB`);
  }

  console.info("Bundle budget summary (gzip):");
  console.info(
    `- Entry JS: ${entryKb}KB / ${budget.maxEntryJsGzipKb}KB (${sizes.entry?.file || "missing"})`,
  );
  console.info(
    `- Largest JS: ${largestJsKb}KB / ${budget.maxAnyJsGzipKb}KB (${sizes.largestJs?.file || "missing"})`,
  );
  console.info(
    `- Largest CSS: ${largestCssKb}KB / ${budget.maxAnyCssGzipKb}KB (${sizes.largestCss?.file || "missing"})`,
  );
  console.info(`- Total JS: ${totalJsKb}KB / ${budget.maxTotalJsGzipKb}KB`);
  console.info(`- Total CSS: ${totalCssKb}KB / ${budget.maxTotalCssGzipKb}KB`);

  if (failures.length > 0) {
    console.error("");
    failures.forEach((line) => console.error(`FAIL: ${line}`));
    process.exit(1);
  }

  console.info("Bundle budgets passed.");
}

main();
