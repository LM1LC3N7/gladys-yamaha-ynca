// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known receivers by address, their model, the
// zones they have (so their devices are published even while the receiver is
// off), the zone names, and the inputs they have shown (the "Input" dropdown
// only grows). No secret: YNCA has none.
//
// The receiver table has no prototype, its keys are addresses checked by
// src/config.js, and everything read back is checked again here.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressKey, parseAddress } from './config.js';
import { LIMITS, ZONES } from './constants.js';
import { cleanText, isInput } from './ynca/protocol.js';

export const emptyData = () => ({ receivers: Object.create(null) });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sanitizeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(options) ? options.slice(0, LIMITS.inputs * 2) : []) {
    if (isObject(option) && isInput(option.value) && !seen.has(option.value)) {
      seen.add(option.value);
      result.push({
        value: option.value,
        label: cleanText(option.label, LIMITS.name) ?? option.value,
      });
    }
  }
  return result.slice(0, LIMITS.inputs);
}

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data) || !isObject(data.receivers)) {
    return base;
  }
  for (const [key, receiver] of Object.entries(data.receivers).slice(0, LIMITS.receivers * 2)) {
    const address = isObject(receiver)
      ? parseAddress(`${receiver.host}:${receiver.port}`)
      : undefined;
    if (!address || addressKey(address) !== key) {
      continue;
    }
    const zoneNames = Object.create(null);
    for (const zone of ZONES) {
      const name = cleanText(receiver.zoneNames?.[zone], LIMITS.name);
      if (name) {
        zoneNames[zone] = name;
      }
    }
    base.receivers[key] = {
      host: address.host,
      port: address.port,
      model: cleanText(receiver.model, LIMITS.name),
      zones: ZONES.filter((z) => Array.isArray(receiver.zones) && receiver.zones.includes(z)),
      zoneNames,
      inputOptions: sanitizeOptions(receiver.inputOptions),
    };
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'yamaha-ynca.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to
   * `yamaha-ynca.json.bad` and `corrupted` is set, so the app says so instead
   * of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
