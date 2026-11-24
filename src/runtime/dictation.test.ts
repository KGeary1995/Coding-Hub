import { afterEach, describe, expect, it } from 'vitest';
import { dictationError, startDictation, spokenText, withSpoken } from './dictation';

const result = (transcript: string, isFinal = true) => ({ isFinal, 0: { transcript } });
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('dictation on the phone', () => {
  it('joins what was said, the phrase still being heard last', () => {
    expect(spokenText([result(' run the tests '), result('and fix', false)])).toBe('run the tests and fix');
    expect(spokenText([])).toBe('');
  });
  it('puts the spoken words after what is already in the box', () => {
    expect(withSpoken('', 'hello')).toBe('hello');
    expect(withSpoken('Please ', 'check it')).toBe('Please check it');
    expect(withSpoken('typed', '')).toBe('typed');
  });
  it('says nothing for silence or a stop, and what to do when the microphone is blocked', () => {
    expect(dictationError('no-speech')).toBe(''); expect(dictationError('aborted')).toBe('');
    expect(dictationError('not-allowed')).toMatch(/Allow the microphone/);
  });
  it('fills the words in as they are heard and never sends them itself', () => {
    let instance: { onresult: (event: unknown) => void; onerror: (event: unknown) => void; onend: () => void; stopped?: boolean } | undefined;
    class Fake { lang = ''; continuous = false; interimResults = false; onresult = () => {}; onerror = () => {}; onend = () => {}; constructor() { instance = this as never; } start() {} stop() { (this as { stopped?: boolean }).stopped = true; this.onend(); } }
    (globalThis as { window?: unknown }).window = { webkitSpeechRecognition: Fake };
    const heard: string[] = []; const ended: string[] = [];
    const stop = startDictation((spoken) => heard.push(spoken), (error) => ended.push(error));
    instance!.onresult({ resultIndex: 0, results: [result('open', false)] });
    instance!.onresult({ resultIndex: 0, results: [result('open the file')] });
    stop();
    expect(heard).toEqual(['open', 'open the file']); expect(ended).toEqual(['']); expect(instance!.stopped).toBe(true);
  });
  it('reports a blocked microphone when listening ends', () => {
    let instance: { onerror: (event: unknown) => void; onend: () => void } | undefined;
    class Fake { onresult = () => {}; onerror = () => {}; onend = () => {}; constructor() { instance = this as never; } start() {} stop() {} }
    (globalThis as { window?: unknown }).window = { SpeechRecognition: Fake };
    const ended: string[] = []; startDictation(() => {}, (error) => ended.push(error));
    instance!.onerror({ error: 'not-allowed' }); instance!.onend();
    expect(ended[0]).toMatch(/Allow the microphone/);
  });
  it('says to use the keyboard microphone where the browser has no dictation', () => {
    (globalThis as { window?: unknown }).window = {};
    const ended: string[] = []; startDictation(() => {}, (error) => ended.push(error));
    expect(ended[0]).toMatch(/keyboard/);
  });
});
