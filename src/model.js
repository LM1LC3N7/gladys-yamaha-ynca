// -----------------------------------------------------------------------------
// Known receivers -> Gladys devices and states (pure). One Gladys device per
// zone of a receiver (main zone, zone 2, 3, 4), keyed by the address of the
// receiver and the zone: YNCA gives no serial number.
//
// The categories and types are the ones of the Gladys core: `music/volume`
// like the core Sonos service, `television/volume-mute` for the mute press
// (music has no mute type), `text/select` for the input and the sound
// program, `button/push` for "Power on" and "Standby", and the power state
// read only (`unknown/binary`): no switch, nothing an "everything on / off"
// (voice assistants, scenes) could turn into a command. No unit: the core
// lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { addressSlug } from './config.js';
import { DEVICE_TYPE, FEATURES } from './constants.js';
import { MAIN_ZONE_SYNC, SOUND_PROGRAMS, dbToPercent } from './ynca/protocol.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Input',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.SOUND_PROGRAM]: {
    name: 'Sound program',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
    mainOnly: true,
  },
});

export const ZONE_LABELS = Object.freeze({
  MAIN: 'Main zone',
  ZONE2: 'Zone 2',
  ZONE3: 'Zone 3',
  ZONE4: 'Zone 4',
});

/** The feature keys of a zone: the sound program on the main zone only. */
export const featureKeys = (zone) =>
  Object.entries(FEATURE_SPECS)
    .filter(([, spec]) => !spec.mainOnly || zone === 'MAIN')
    .map(([key]) => key);

export const SOUND_PROGRAM_OPTIONS = Object.freeze(
  SOUND_PROGRAMS.map((value) => Object.freeze({ value, label: value })),
);

/** The options of the "Input" dropdown of a zone: every input the receiver has shown. */
export function inputOptions(receiver, zone) {
  const options = (Array.isArray(receiver.inputOptions) ? receiver.inputOptions : []).map(
    ({ value, label }) => ({ value, label }),
  );
  if (zone !== 'MAIN' && !options.some((o) => o.value === MAIN_ZONE_SYNC)) {
    options.push({ value: MAIN_ZONE_SYNC, label: MAIN_ZONE_SYNC });
  }
  return options;
}

export const zoneIds = (gladys, receiver, zone) =>
  gladys.externalIds(DEVICE_TYPE, `${addressSlug(receiver)}-${zone.toLowerCase()}`);

export function deviceName(receiver, zone) {
  const model = receiver.model || 'Yamaha';
  const name = receiver.zoneNames?.[zone];
  return name ? `${name} (${model} ${ZONE_LABELS[zone]})` : `${model} ${ZONE_LABELS[zone]}`;
}

export function buildDevice(gladys, receiver, zone) {
  const ids = zoneIds(gladys, receiver, zone);
  return {
    name: deviceName(receiver, zone),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'IP_ADDRESS', value: receiver.host },
      { name: 'ZONE', value: zone },
    ],
    // Always the full, fixed list of the zone: a device published again never loses a feature.
    features: featureKeys(zone).map((key) => {
      // eslint-disable-next-line no-unused-vars
      const { name, mainOnly, ...spec } = FEATURE_SPECS[key];
      return {
        name,
        external_id: ids.feature(key),
        read_only: false,
        has_feedback: false,
        keep_history: false,
        ...spec,
        ...(key === FEATURES.SOURCE ? { supported_options: inputOptions(receiver, zone) } : {}),
        ...(key === FEATURES.SOUND_PROGRAM
          ? { supported_options: SOUND_PROGRAM_OPTIONS.map((o) => ({ ...o })) }
          : {}),
      };
    }),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a zone. `zoneState` is the state of the zone on a connected
 * receiver, `null` for a receiver that does not answer (power 0 only),
 * undefined for "nothing known" (nothing published).
 */
export function stateList(gladys, receiver, zone, zoneState) {
  if (zoneState === undefined) {
    return [];
  }
  const ids = zoneIds(gladys, receiver, zone);
  const id = (key) => ids.feature(key);
  if (zoneState === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof zoneState.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: zoneState.power ? 1 : 0 });
  }
  if (Number.isFinite(zoneState.volume)) {
    states.push({
      device_feature_external_id: id(FEATURES.VOLUME),
      state: dbToPercent(zoneState.volume),
    });
  }
  if (typeof zoneState.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: zoneState.mute ? 1 : 0 });
  }
  if (
    typeof zoneState.input === 'string' &&
    inputOptions(receiver, zone).some((o) => o.value === zoneState.input)
  ) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: zoneState.input });
  }
  if (zone === 'MAIN' && typeof zoneState.soundProgram === 'string') {
    states.push({
      device_feature_external_id: id(FEATURES.SOUND_PROGRAM),
      text: zoneState.soundProgram,
    });
  }
  return states;
}
