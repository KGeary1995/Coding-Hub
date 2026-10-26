// The installed product's name, and the prefix of its download files. Before 1.11 the app installed as "AI Coding Hub";
// TRACE_LEGACY_PRODUCT_NAME=1 builds under that name, only so the Windows upgrade test can install an old-name baseline
// and check that installing Trace over it replaces it.
const CURRENT = { name: 'Trace', prefix: 'Trace' };
const LEGACY = { name: 'AI Coding Hub', prefix: 'AI-Coding-Hub' };
const product = (env = process.env) => env.TRACE_LEGACY_PRODUCT_NAME === '1' ? LEGACY : CURRENT;
module.exports = { product, CURRENT, LEGACY };
