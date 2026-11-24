const fs = require('node:fs');

/** GitHub refuses a release description over 125,000 characters (HTTP 422); this leaves room to spare. */
const LIMIT = 100_000;
const VERSION = /^\d+\.\d+\.\d+ /;

/**
 * The public release description from docs/RELEASE_NOTES.md: the newest versions' notes while they fit, a line pointing
 * to the earlier releases for the rest, and the Install section. The file keeps every version (1.36.0 was refused at
 * 128,878 characters). A version's notes are its paragraph that starts with the version and the lines up to the next.
 */
function releaseDescription(text, limit = LIMIT) {
  const source = text.replace(/\r\n/g, '\n'); const install = source.indexOf('\n## Install');
  const notes = install < 0 ? source : source.slice(0, install); const tail = install < 0 ? '' : source.slice(install);
  if (source.length <= limit) return source;
  const lines = notes.split('\n'); const starts = lines.flatMap((line, index) => VERSION.test(line) ? [index] : []);
  const note = '\nNotes for earlier versions are on their own releases: https://github.com/KGeary1995/trace-releases/releases\n';
  let kept = lines.slice(0, starts[0] ?? lines.length).join('\n');
  for (let i = 0; i < starts.length; i++) {
    const block = '\n' + lines.slice(starts[i], starts[i + 1] ?? lines.length).join('\n');
    // The newest version is always kept whole, however long its notes are.
    if (i > 0 && kept.length + block.length + note.length + tail.length > limit) return `${kept.trimEnd()}\n${note}${tail}`;
    kept += block;
  }
  return kept + tail;
}

module.exports = { releaseDescription, LIMIT };
// node scripts/release-notes.cjs <notes.md> <out.md>
if (require.main === module) fs.writeFileSync(process.argv[3], releaseDescription(fs.readFileSync(process.argv[2], 'utf8')));
