// -----------------------------------------------------------------------------
// The YNCA protocol, pure: one line per message, `@<SUBUNIT>:<FUNCTION>=<value>`
// ended by CR LF, `?` as value to read, `@UNDEFINED` / `@RESTRICTED` for a
// refused line. Ported from the ynca Python library (MIT, see
// THIRD_PARTY_NOTICES.md): protocol.py (parsing), constants.py (volume range),
// enums.py (inputs, sound programs, values), subunits/ (functions per subunit).
// -----------------------------------------------------------------------------

import { VOLUME_DB } from '../constants.js';

/** The input subunits and the input each one gives (enums.py `Input` of ynca). */
export const SUBUNIT_INPUTS = Object.freeze({
  AIRPLAY: 'AirPlay',
  BT: 'Bluetooth',
  DAB: 'TUNER',
  DEEZER: 'Deezer',
  IPOD: 'iPod',
  IPODUSB: 'iPod (USB)',
  MCLINK: 'MusicCast Link',
  NAPSTER: 'Napster',
  NETRADIO: 'NET RADIO',
  PANDORA: 'Pandora',
  PC: 'PC',
  RHAP: 'Rhapsody',
  SERVER: 'SERVER',
  SIRIUS: 'SIRIUS',
  SIRIUSIR: 'SIRIUS InternetRadio',
  SIRIUSXM: 'SiriusXM',
  SPOTIFY: 'Spotify',
  TIDAL: 'TIDAL',
  TUN: 'TUNER',
  UAW: 'UAW',
  USB: 'USB',
});

/** The inputs with a connector on the receiver (enums.py `Input` of ynca). */
export const PHYSICAL_INPUTS = Object.freeze([
  'AUDIO',
  'AUDIO1',
  'AUDIO2',
  'AUDIO3',
  'AUDIO4',
  'AUDIO5',
  'AV1',
  'AV2',
  'AV3',
  'AV4',
  'AV5',
  'AV6',
  'AV7',
  'CD',
  'COAXIAL1',
  'COAXIAL2',
  'DOCK',
  'HDMI1',
  'HDMI2',
  'HDMI3',
  'HDMI4',
  'HDMI5',
  'HDMI6',
  'HDMI7',
  'LINE1',
  'LINE2',
  'LINE3',
  'MULTI CH',
  'OPTICAL1',
  'OPTICAL2',
  'PHONO',
  'TV',
  'V-AUX',
]);

/** Zone 2, 3 and 4 can follow the input of the main zone. */
export const MAIN_ZONE_SYNC = 'Main Zone Sync';

/** Every input value YNCA knows: the only values ever sent with `INP`. */
export const ALL_INPUTS = Object.freeze([
  ...new Set([...PHYSICAL_INPUTS, ...Object.values(SUBUNIT_INPUTS), MAIN_ZONE_SYNC]),
]);
const INPUT_SET = new Set(ALL_INPUTS);
export const isInput = (value) => typeof value === 'string' && INPUT_SET.has(value);

/**
 * `@SYS:INPNAME<suffix>=<name>`: the suffix is the input itself, except for
 * the two inputs whose value has a space or a dash (system.py of ynca).
 */
const INPNAME_SUFFIX = Object.freeze({ MULTICH: 'MULTI CH', VAUX: 'V-AUX' });
export function inputOfInpname(fn) {
  if (typeof fn !== 'string' || !fn.startsWith('INPNAME') || fn.length === 'INPNAME'.length) {
    return undefined;
  }
  const suffix = fn.slice('INPNAME'.length);
  const input = Object.hasOwn(INPNAME_SUFFIX, suffix) ? INPNAME_SUFFIX[suffix] : suffix;
  return INPUT_SET.has(input) && input !== MAIN_ZONE_SYNC ? input : undefined;
}

/** The sound programs (enums.py `SoundPrg` of ynca): the only values ever sent with `SOUNDPRG`. */
export const SOUND_PROGRAMS = Object.freeze([
  'Hall in Munich',
  'Hall in Vienna',
  'Hall in Amsterdam',
  'Hall in Frankfurt',
  'Hall in Stuttgart',
  'Hall in Munich A',
  'Hall in Munich B',
  'Hall in USA A',
  'Hall in USA B',
  'Church in Freiburg',
  'Church in Royaumont',
  'Church in Tokyo',
  'Chamber',
  'Village Vanguard',
  'Village Gate',
  'Warehouse Loft',
  'Cellar Club',
  'The Roxy Theatre',
  'The Bottom Line',
  'Arena',
  'Pavilion',
  'Disco',
  'Recital/Opera',
  'Sports',
  'Action Game',
  'Roleplaying Game',
  'Music Video',
  'Standard',
  'Spectacle',
  'Sci-Fi',
  'Adventure',
  'Drama',
  'Mono Movie',
  'Enhanced',
  'Surround Decoder',
  '2ch Stereo',
  '5ch Stereo',
  '7ch Stereo',
  '9ch Stereo',
  '11ch Stereo',
  'All-Ch Stereo',
]);
const SOUND_PROGRAM_SET = new Set(SOUND_PROGRAMS);
export const isSoundProgram = (value) => typeof value === 'string' && SOUND_PROGRAM_SET.has(value);

export const POWER = Object.freeze({ ON: 'On', STANDBY: 'Standby' });
/** `Att -20 dB` and `Att -40 dB` are attenuations: muted for Gladys. */
export const MUTE = Object.freeze({ ON: 'On', OFF: 'Off' });
const MUTE_VALUES = new Set(['On', 'Off', 'Att -20 dB', 'Att -40 dB']);

const NAME = /^[A-Z0-9]{1,16}$/;
const FUNCTION = /^[A-Z0-9]{1,40}$/;
/** What a value sent may hold: printable ASCII, never a line break nor `@`. */
const VALUE = /^[\x20-\x3f\x41-\x7e]{1,64}$/;

/** Control and bidi characters out, trimmed, cut to `max`. undefined when empty. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  const trimmed = text.trim().slice(0, max).trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * One received line (without its CR LF), parsed linearly (two `indexOf`, no
 * backtracking): `{ status: 'ok', subunit, fn, value }`, `{ status:
 * 'undefined' }`, `{ status: 'restricted' }`, or undefined when it is not a
 * YNCA line. The value is the raw text after the first `=` that follows the
 * first `:` (as the regular expression of ynca).
 */
export function parseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('@')) {
    return undefined;
  }
  if (line === '@UNDEFINED') {
    return { status: 'undefined' };
  }
  if (line === '@RESTRICTED') {
    return { status: 'restricted' };
  }
  const colon = line.indexOf(':');
  if (colon < 2) {
    return undefined;
  }
  const equals = line.indexOf('=', colon + 1);
  if (equals < colon + 2) {
    return undefined;
  }
  const subunit = line.slice(1, colon);
  const fn = line.slice(colon + 1, equals);
  if (!NAME.test(subunit) || !FUNCTION.test(fn)) {
    return undefined;
  }
  return { status: 'ok', subunit, fn, value: line.slice(equals + 1) };
}

/** One line to send (without its CR LF). Throws on anything that is not a plain YNCA line. */
export function formatLine(subunit, fn, value) {
  if (!NAME.test(subunit) || !FUNCTION.test(fn) || !VALUE.test(String(value))) {
    throw new Error('Invalid YNCA line');
  }
  return `@${subunit}:${fn}=${value}`;
}

export const getLine = (subunit, fn) => formatLine(subunit, fn, '?');

/** A volume in dB as YNCA writes it: `-30.5`, `0.0`, `16.5`. undefined when invalid or out of range. */
export function parseDb(text) {
  if (typeof text !== 'string' || !/^-?\d{1,2}(?:\.\d)?$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= VOLUME_DB.min && value <= VOLUME_DB.max ? value : undefined;
}

/** A dB value rounded to the YNCA step (0.5), in range. */
export function stepDb(value) {
  const stepped = Math.round(value / VOLUME_DB.step) * VOLUME_DB.step;
  return Math.min(VOLUME_DB.max, Math.max(VOLUME_DB.min, stepped));
}

/** A dB value as YNCA takes it: one decimal, never `-0.0`. */
export function formatDb(value) {
  const stepped = stepDb(value);
  return (stepped === 0 ? 0 : stepped).toFixed(1);
}

const SPAN = VOLUME_DB.max - VOLUME_DB.min;

/** 0..100 -> dB, on the YNCA step. */
export const percentToDb = (percent) => stepDb(VOLUME_DB.min + (percent * SPAN) / 100);

/** dB -> 0..100 (integer). */
export const dbToPercent = (db) =>
  Math.min(100, Math.max(0, Math.round(((db - VOLUME_DB.min) * 100) / SPAN)));

/** `PWR`: true on, false standby, undefined otherwise. */
export function parsePower(value) {
  if (value === POWER.ON) {
    return true;
  }
  return value === POWER.STANDBY ? false : undefined;
}

/** `MUTE`: true muted or attenuated, false off, undefined otherwise. */
export function parseMute(value) {
  if (!MUTE_VALUES.has(value)) {
    return undefined;
  }
  return value !== MUTE.OFF;
}
