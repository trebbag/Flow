import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

async function main() {
  const root = process.cwd();
  const distDir = path.join(root, "dist");
  const indexPath = path.join(distDir, "index.html");

  const indexHtml = await fs.readFile(indexPath, "utf8");
  assert.match(indexHtml, /<div id="root"><\/div>/, "index.html must contain the React root container");

  const assetsDir = path.join(distDir, "assets");
  const assetFiles = await fs.readdir(assetsDir);
  const jsBundles = assetFiles.filter((file) => file.endsWith(".js"));
  const cssBundles = assetFiles.filter((file) => file.endsWith(".css"));

  assert.ok(jsBundles.length > 0, "expected compiled JavaScript bundles in dist/assets");
  assert.ok(cssBundles.length > 0, "expected a compiled CSS bundle in dist/assets");

  const jsStats = await Promise.all(jsBundles.map((file) => fs.stat(path.join(assetsDir, file))));
  const cssStats = await Promise.all(cssBundles.map((file) => fs.stat(path.join(assetsDir, file))));
  const totalJsSize = jsStats.reduce((sum, stat) => sum + stat.size, 0);
  const largestJsSize = jsStats.reduce((max, stat) => Math.max(max, stat.size), 0);
  const totalCssSize = cssStats.reduce((sum, stat) => sum + stat.size, 0);

  // Guard against empty/partial builds while allowing route-level code splitting.
  assert.ok(totalJsSize > 100_000, "compiled JS output is unexpectedly small");
  assert.ok(largestJsSize > 50_000, "largest compiled JS chunk is unexpectedly small");
  assert.ok(totalCssSize > 20_000, "compiled CSS output is unexpectedly small");

  console.info("Visual artifact checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
