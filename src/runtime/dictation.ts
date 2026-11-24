/**
 * Speaking a message on the phone (the browser's Web Speech API: Safari uses Apple's dictation, Chrome on Android
 * Google's). The words go into the message box and are never sent on their own: the person reads them and presses Send,
 * so a misheard command cannot reach an agent. Not offered on the computer, whose Electron has no speech service.
 */
interface SpeechResult { isFinal: boolean; 0: { transcript: string } }
interface SpeechEvent { resultIndex: number; results: ArrayLike<SpeechResult> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void;
}
type RecognitionClass = new () => Recognition;

const recognitionClass = () => typeof window === 'undefined' ? undefined : (window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: RecognitionClass }).webkitSpeechRecognition;
export const dictationSupported = () => Boolean(recognitionClass());

/** What was said so far: every result in order, the last one possibly still being heard. */
export function spokenText(results: ArrayLike<SpeechResult>) { return Array.from(results, (result) => result[0].transcript.trim()).filter(Boolean).join(' '); }
/** The field's text with the spoken words after it, a space between. */
export const withSpoken = (before: string, spoken: string) => !spoken ? before : !before.trim() ? spoken : `${before.replace(/\s+$/, '')} ${spoken}`;

/** Why dictation stopped, in words a person can act on; nothing for silence or being stopped. */
export function dictationError(code: string) {
  if (code === 'no-speech' || code === 'aborted') return '';
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Allow the microphone for this page in the browser’s settings, then try again.';
  if (code === 'audio-capture') return 'No microphone was found.';
  if (code === 'network') return 'Dictation needs a connection to the phone’s speech service.';
  return 'Dictation stopped. Try again.';
}

/**
 * Starts listening; `heard` gets everything said so far each time it changes, and `ended` once listening stops (with a
 * reason when it failed). Returns the function that stops it.
 */
export function startDictation(heard: (spoken: string) => void, ended: (error: string) => void): () => void {
  const Class = recognitionClass(); if (!Class) { ended('This browser cannot take dictation. Use the microphone on the keyboard instead.'); return () => {}; }
  const recognition = new Class(); let error = '';
  recognition.lang = navigator.language || 'en-US'; recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = (event) => heard(spokenText(event.results));
  recognition.onerror = (event) => { error = dictationError(event.error); };
  recognition.onend = () => ended(error);
  try { recognition.start(); } catch { ended('Dictation could not start. Try again.'); return () => {}; }
  return () => { try { recognition.stop(); } catch { /* Already stopped. */ } };
}
