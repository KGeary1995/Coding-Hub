import fs from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/**
 * A file of the phone app build (`dist/phone`): `index.html` for `/`, and plainly named files at its top level or in
 * `assets/`. Nothing else under the app, and no links, can be reached.
 */
export function phoneFile(root: string, pathname: string): { body: Buffer; type: string; immutable: boolean } | null {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^(assets\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(relative)) return null;
  const type = TYPES[path.extname(relative)]; if (!type) return null;
  const file = path.join(root, relative);
  try {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return null;
    // Built assets carry a content hash in their name, so phones may keep them; the page and manifest are always checked.
    return { body: fs.readFileSync(file), type, immutable: relative.startsWith('assets/') };
  } catch { return null; }
}
