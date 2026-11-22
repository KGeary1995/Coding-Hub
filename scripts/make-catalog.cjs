const fs = require('node:fs');
const path = require('node:path');
// Writes release/catalog.json: the price list and Claude Code's model names this version was built with, published
// with each release so installed copies can take a newer list between releases (electron/services/hub/catalog.ts).
// Run after the host is built (dist-electron). To change a price or add a model between releases, edit a copy of the
// published file (a later "asOf" date) and replace it on the latest release:
//   gh release upload v<version> catalog.json --clobber --repo KGeary1995/trace-releases
const built = path.resolve(__dirname, '../dist-electron/shared');
const { BUILT_IN_PRICES, PRICES_AS_OF } = require(path.join(built, 'model-prices.js'));
const { CLAUDE_MODELS } = require(path.join(built, 'model-name.js'));
const target = path.resolve(__dirname, '../release/catalog.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ asOf: PRICES_AS_OF, prices: BUILT_IN_PRICES, claudeModels: CLAUDE_MODELS }, null, 2) + '\n');
console.log(`catalog.json: ${BUILT_IN_PRICES.length} prices, ${CLAUDE_MODELS.length} Claude models, as of ${PRICES_AS_OF}`);
