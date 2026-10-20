// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME_DB } from './constants.js';
import { stepDb } from './ynca/protocol.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume_db: MAX_VOLUME_DB.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a receiver typed by the user: an IPv4 address or a host
 * name, with an optional port (50000 by default; a pasted URL is reduced to
 * its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(?:https?|tcp|socket):\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const colon = text.indexOf(':');
  const host = colon === -1 ? text : text.slice(0, colon);
  const portText = colon === -1 ? undefined : text.slice(colon + 1);
  if (portText !== undefined && !/^\d{1,5}$/.test(portText)) {
    return undefined;
  }
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (port < 1 || port > 65535 || host === '' || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** The part of the external ids that names a receiver: its address, letters, digits and dashes only. */
export const addressSlug = (address) => addressKey(address).replace(/[^a-z0-9]+/g, '-');

/**
 * The volume cap in dB: -80..+16.5, on the YNCA step (0.5). Anything
 * unreadable gives the default; a value out of range is brought into it.
 */
export function parseMaxVolumeDb(raw) {
  const value = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_VOLUME_DB.default;
  }
  return Math.min(MAX_VOLUME_DB.max, Math.max(MAX_VOLUME_DB.min, stepDb(value)));
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (!addresses.some((a) => addressKey(a) === addressKey(address))) {
      if (addresses.length < LIMITS.receivers) {
        addresses.push(address);
      } else {
        invalid.push(entry.slice(0, 100));
      }
    }
  }
  return { addresses, invalid, maxVolumeDb: parseMaxVolumeDb(c.max_volume_db) };
}
