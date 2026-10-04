import { readFileSync, statSync } from 'node:fs';
import { Upstream } from '../util/errors.js';
import { log } from '../util/logger.js';

/**
 * Speech-to-text for the owner's voice notes (docs/LLD-app-fixes.md §7): Deepgram, with the Iris
 * production key the owner approved for this, read once at start from `<opsDir>/workplace/stt.env`
 * (mode 600). The key never reaches a log line, an error message or a response.
 */

export type Transcriber = (audio: Buffer, mediaType: string) => Promise<string>;

let apiKey: string | null = null;
let override: Transcriber | null = null;

/** Read DEEPGRAM_API_KEY from an env file. Missing file → voice notes are off (503), not a crash. */
export function loadSttKey(path: string): boolean {
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) log.warn('stt', `${path} is readable by others; chmod 600 it`);
    const line = readFileSync(path, 'utf8').split('\n').find(l => /^\s*DEEPGRAM_API_KEY\s*=/.test(l));
    const value = line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    apiKey = value || null;
  } catch {
    apiKey = null;
  }
  log.info('stt', apiKey ? 'speech-to-text key loaded' : `no speech-to-text key (${path}); voice notes are off`);
  return apiKey !== null;
}

/** Tests (and a future provider) replace the call. */
export function useTranscriber(fn: Transcriber | null): void { override = fn; }

export async function transcribe(audio: Buffer, mediaType: string): Promise<string> {
  const text = override ? await override(audio, mediaType) : await deepgram(audio, mediaType);
  if (!text.trim()) throw new Upstream('Couldn\'t transcribe that voice note (no speech heard); try again or type it.');
  return text.trim();
}

async function deepgram(audio: Buffer, mediaType: string): Promise<string> {
  if (!apiKey) throw new Upstream('Voice notes are off: no speech-to-text key on the Mac.', 503);
  const url = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Token ${apiKey}`, 'content-type': mediaType },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    log.warn('stt', `deepgram unreachable: ${err instanceof Error ? err.name : 'error'}`);
    throw new Upstream('Couldn\'t transcribe that voice note; try again or type it.');
  }
  if (!res.ok) {
    log.warn('stt', `deepgram ${res.status}`);
    throw new Upstream('Couldn\'t transcribe that voice note; try again or type it.');
  }
  const body = await res.json() as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}
