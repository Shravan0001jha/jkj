/**
 * Is a macOS host attached to the Workplace? (17 Oct: the Workplace moved to a Linux cloud server.)
 *
 * The Mac queue (request_mac), the COO live window and the tool texts that send work to "the Mac" only
 * make sense when the server runs on a Mac. Off macOS they refuse cleanly instead of handing out a
 * "Mac slot" whose shell is Linux. WORKPLACE_MAC_HOST=1 says a Mac is attached anyway (room for a
 * future remote Mac); WORKPLACE_MAC_HOST=0 says none is, even on darwin.
 */

export const NO_MAC_REFUSAL =
  "No Mac is attached to the Workplace (cloud server): Mac-only live checks wait until a Mac is connected; park the Mac-only part of the story with resumeWhen 'a Mac is attached'.";

export function detectMacHost(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['WORKPLACE_MAC_HOST'] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return platform === 'darwin';
}

let override: boolean | undefined;

/** Read at call time, so a test (or a later env change) needs no restart of the module. */
export function macHost(): boolean {
  return override ?? detectMacHost();
}

/** Test-only: pretend a Mac is (true) or is not (false) attached; undefined goes back to detection. */
export function setMacHostForTest(value: boolean | undefined): void {
  override = value;
}
