import { describe, expect, it } from 'vitest';
import { jsonField } from './json-field';

describe('a JSON field typed by the person', () => {
  it('parses valid JSON, and names the field in plain words when it is not', () => {
    expect(jsonField<string[]>('["-y", "server"]', 'Arguments')).toEqual(['-y', 'server']);
    expect(() => jsonField('[-y', 'Arguments')).toThrow('Arguments is not valid JSON. Check its brackets, quotes and commas.');
  });
});
