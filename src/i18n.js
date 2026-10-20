// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration button, connection status),
// in English and French.
// -----------------------------------------------------------------------------

import { ZONE_LABELS } from './model.js';

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');
const db = (value) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;

const ZONE_LABELS_FR = Object.freeze({
  MAIN: 'zone principale',
  ZONE2: 'zone 2',
  ZONE3: 'zone 3',
  ZONE4: 'zone 4',
});

function zoneText(zone, state) {
  const en = [];
  const fr = [];
  en.push(state.power === true ? 'on' : state.power === false ? 'standby' : 'power unknown');
  fr.push(
    state.power === true ? 'allumée' : state.power === false ? 'en veille' : 'marche inconnue',
  );
  if (Number.isFinite(state.volume)) {
    en.push(`volume ${db(state.volume)}`);
    fr.push(`volume ${db(state.volume)}`);
  }
  if (state.mute === true) {
    en.push('muted');
    fr.push('sourdine');
  }
  if (state.input) {
    en.push(`input ${state.input}`);
    fr.push(`entrée ${state.input}`);
  }
  return both(`${ZONE_LABELS[zone]} ${en.join(', ')}`, `${ZONE_LABELS_FR[zone]} ${fr.join(', ')}`);
}

export const T = {
  noReceiver: both(
    'No receiver configured: type the IP address of each receiver in the configuration.',
    "Aucun ampli configuré : saisissez l'adresse IP de chaque ampli dans la configuration.",
  ),
  check: (lines, maxVolumeDb) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${db(maxVolumeDb)}`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${db(maxVolumeDb)}`].join(' · '),
  }),
  checkLine: (label, link) => {
    if (!link?.connected) {
      const busy = link?.busyHint;
      return both(
        `${label}: not connected (off without network standby, unreachable${busy ? ', or the YNCA port held by another client' : ''})`,
        `${label} : non connecté (éteint sans veille réseau, injoignable${busy ? ', ou port YNCA pris par un autre client' : ''})`,
      );
    }
    const zones = Object.keys(link.state.zones).filter((z) => z in ZONE_LABELS);
    const parts = zones.map((zone) => zoneText(zone, link.state.zones[zone]));
    return both(
      `${label}: connected, ${link.state.model}${parts.length ? `; ${parts.map((p) => p.en).join('; ')}` : ''}`,
      `${label} : connecté, ${link.state.model}${parts.length ? ` ; ${parts.map((p) => p.fr).join(' ; ')}` : ''}`,
    );
  },
  unreachable: (names) =>
    both(
      `Not connected (off without network standby, or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (éteints sans veille réseau, ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No YNCA receiver answers yet at: ${list(addresses)}.`,
      `Aucun ampli YNCA ne répond encore à : ${list(addresses)}.`,
    ),
  busy: (addresses) =>
    both(
      `The connection opens but the receiver does not answer at: ${list(addresses)}. A receiver accepts few YNCA clients at a time: close the other one (Home Assistant, another tool) if any.`,
      `La connexion s'ouvre mais l'ampli ne répond pas à : ${list(addresses)}. Un ampli accepte peu de clients YNCA à la fois : fermez l'autre (Home Assistant, un autre outil) s'il y en a un.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid, or more than 10 receivers): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides, ou plus de 10 amplis) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved receiver list was unreadable and was reset; the receivers are read again from their addresses.',
    'La liste enregistrée des amplis était illisible et a été réinitialisée ; les amplis sont relus à leurs adresses.',
  ),
};
