import { HostError, type ReadLimits } from './contracts.js';
import { readLimitRanges } from './browser-limits.generated.js';
export { defaultReadLimits } from './browser-limits.generated.js';

export const chromeAppId = 'ariadne.chrome';

/** Matches the native BrowserURL policy. The full URL remains a separate identity. */
export function browserOrigin(raw: string): string | undefined {
  if (Buffer.byteLength(raw) > 8192 || /[\s\p{White_Space}\p{Cc}\\]/u.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return undefined;
  const match = /^(https|http):\/\/([A-Za-z0-9.-]+)(?::([0-9]+))?(?=[/?#]|$)/.exec(raw);
  if (!match) return undefined;
  if (match[3] !== undefined && (!/^[1-9][0-9]{0,4}$/.test(match[3]))) return undefined;
  const scheme = match[1]!, host = match[2]!.toLowerCase(), port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return undefined;
  if (scheme === 'http' && host !== '127.0.0.1') return undefined;
  return `${scheme}://${host}${port === undefined || port === (scheme === 'https' ? 443 : 80) ? '' : `:${port}`}`;
}
export function canonicalOrigin(raw: string): string {
  if (browserOrigin(raw) !== raw) throw new HostError('invalid_request', 'Expected a canonical browser origin');
  return raw;
}

const ranges: Record<keyof ReadLimits, readonly [number, number]> = readLimitRanges;
export function validateReadLimits(value: unknown): asserts value is ReadLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostError('invalid_request', 'Invalid read limits');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== Object.keys(ranges).length || Object.entries(ranges).some(([key, [min, max]]) => !Number.isSafeInteger(record[key]) || (record[key] as number) < min || (record[key] as number) > max)) throw new HostError('invalid_request', 'Invalid read limits');
}
