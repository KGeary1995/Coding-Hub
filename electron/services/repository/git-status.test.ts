import { describe, expect, it } from 'vitest';
import { parseStatus } from './git';

const status = (...records: string[]) => parseStatus(Buffer.from(records.join('\0') + '\0'), '/p');

describe('Git status', () => {
  it('reads the upstream branch and how far ahead and behind the branch is', () => {
    expect(status('# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1')).toMatchObject({ branch: 'main', head: 'abc', upstream: 'origin/main', ahead: 2, behind: 1 });
  });
  it('has neither with no upstream', () => {
    const value = status('# branch.oid abc', '# branch.head topic');
    expect(value.upstream).toBeUndefined(); expect(value.ahead).toBeUndefined();
  });
});
