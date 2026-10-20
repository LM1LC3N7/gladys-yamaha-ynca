// -----------------------------------------------------------------------------
// The integration: the receivers typed in the configuration, one persistent
// YNCA connection per receiver (src/ynca/link.js: pushed lines, keep-alive,
// reconnection spaced out), one Gladys device per zone, the commands
// (validated before anything is queued, the volume capped by the
// configuration, serialized per receiver, each within the 5 s Gladys waits
// for its ack) and the "Check" button. index.js only wires the SDK handlers to
// it (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { FEATURES, LIMITS, TIMINGS, ZONES } from './constants.js';
import { T } from './i18n.js';
import {
  buildDevice,
  deviceName,
  featureKey,
  featureKeys,
  inputOptions,
  stateList,
  zoneIds,
} from './model.js';
import { FileStore, emptyData, sanitizeOptions } from './store.js';
import { DeviceError, ERROR_KINDS } from './ynca/connection.js';
import { ReceiverLink } from './ynca/link.js';
import {
  MUTE,
  ALL_INPUTS,
  POWER,
  SUBUNIT_INPUTS,
  formatDb,
  isInput,
  isSoundProgram,
  parseDb,
  parseMute,
  percentToDb,
  stepDb,
} from './ynca/protocol.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.STANDBY, FEATURES.MUTE]);

/** Commands that go before the ones waiting: quieting down never waits behind the rest. */
const URGENT = new Set([FEATURES.STANDBY, FEATURES.MUTE]);

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** The input options a connected receiver shows: its named physical inputs, then its input subunits. */
export function linkInputOptions(state) {
  const options = [];
  for (const input of ALL_INPUTS) {
    if (state.inputNames.has(input)) {
      const name = state.inputNames.get(input);
      options.push({ value: input, label: name && name !== input ? `${name} (${input})` : input });
    }
  }
  for (const [subunit, input] of Object.entries(SUBUNIT_INPUTS)) {
    if (state.inputSubunits.has(subunit) && !options.some((o) => o.value === input)) {
      options.push({ value: input, label: input });
    }
  }
  return options;
}

const short = (value) => String(value).slice(0, 32);

export class YncaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'yamaha-ynca' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    createSocket,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.createSocket = createSocket;
    this.config = normalizeConfig();
    this.data = undefined;
    /** addressKey -> ReceiverLink */
    this.links = new Map();
    /** addressKey -> command queue of the receiver */
    this.queues = new Map();
    /** device external ids of the zones created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** `<addressKey>|<zone>` -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** `<addressKey>|<zone>` -> { timer }: the one wake-up check chain of a zone */
    this.wakeChecks = new Map();
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The connections to the receivers are kept (a
   * reconnection to Gladys never drops them); what this app remembered as
   * "already published" is forgotten, since the core forgot it too.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/yamaha-ynca.json moved to yamaha-ynca.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent receivers again (never sooner than
    // the base interval); a reconnection to Gladys does not: Gladys flapping
    // must never make the receivers asked faster.
    await this.step('open the connections', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const key of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(key);
    }
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** The background round: the created devices if unread, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The command queue of one receiver (one YNCA connection): one command at a
   * time. An `urgent` command (standby, mute) goes before the commands still
   * waiting (after the other urgent ones), never before the one running.
   */
  enqueue(key, task, { urgent = false } = {}) {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(key, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  // --- Known receivers ---------------------------------------------------------

  /** The receivers of the configuration that answered once (their record in /data). */
  get receivers() {
    return this.config.addresses
      .map((address) => this.data?.receivers[addressKey(address)])
      .filter(Boolean);
  }

  /** The receiver and zone of a Gladys device, or undefined. */
  zoneOf(gladysDevice) {
    for (const receiver of this.receivers) {
      for (const zone of receiver.zones) {
        if (zoneIds(this.gladys, receiver, zone).device === gladysDevice?.external_id) {
          return { receiver, zone, key: addressKey(receiver) };
        }
      }
    }
    return undefined;
  }

  connectedLink(receiver) {
    const link = this.links.get(addressKey(receiver));
    return link?.connected ? link : undefined;
  }

  /**
   * What is known of a zone: its state when the receiver is connected, null
   * when the receiver does not answer, undefined when nothing is known yet
   * (first connection in progress, or a connection just lost).
   */
  zoneState(receiver, zone) {
    const link = this.links.get(addressKey(receiver));
    if (link?.connected) {
      return link.state.zones[zone];
    }
    return link && link.lastError && !link.connected ? null : undefined;
  }

  /** One link per address of the configuration. */
  syncLinks({ retry = false } = {}) {
    if (!this.started) {
      return;
    }
    const wanted = new Map(this.config.addresses.map((a) => [addressKey(a), a]));
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const link = new ReceiverLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.now,
        createSocket: this.createSocket,
        onEvent: (event, source, extra) => this.linkEvent(event, source, extra),
      });
      this.links.set(key, link);
      link.start();
    }
  }

  linkEvent(event, link, changed) {
    if (this.links.get(link.key) !== link || !this.data) {
      return;
    }
    if (event === 'up') {
      const { receiver, structure } = this.remember(link);
      if (receiver) {
        this.logger.info(`${receiver.model} connected at ${link.key}`);
        if (structure) {
          this.publishDevices().catch((err) =>
            this.logger.warn(`Could not publish the devices: ${err.message}`),
          );
        }
        receiver.zones.forEach((zone) => this.schedulePublish(receiver, zone, 0));
      }
    } else if (event === 'update') {
      const { receiver, structure } = this.remember(link);
      if (receiver && structure) {
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
      }
      if (receiver && ZONES.includes(changed)) {
        this.schedulePublish(receiver, changed);
      }
    } else if (event === 'failed') {
      // The receiver does not answer: power 0 on its zones.
      const receiver = this.data.receivers[link.key];
      receiver?.zones.forEach((zone) => this.schedulePublish(receiver, zone, 0));
    }
    this.updateStatus().catch(() => {});
  }

  /**
   * Keeps what a connected receiver shows: its model, its zones (never
   * dropped), the zone names, its inputs (the dropdown only grows). Returns
   * the receiver and whether its Gladys devices must be published again.
   */
  remember(link) {
    const table = this.data.receivers;
    const state = link.state;
    let receiver = Object.hasOwn(table, link.key) ? table[link.key] : undefined;
    let structure = false;
    if (!receiver) {
      if (Object.keys(table).length >= LIMITS.receivers * 2) {
        this.warnOnce('receivers', 'Too many receivers known: the next ones are ignored');
        return {};
      }
      receiver = {
        host: link.host,
        port: link.port,
        model: undefined,
        zones: [],
        zoneNames: Object.create(null),
        inputOptions: [],
      };
      table[link.key] = receiver;
      structure = true;
    }
    if (state.model && state.model !== receiver.model) {
      receiver.model = state.model;
      structure = true;
    }
    const zones = ZONES.filter((z) => receiver.zones.includes(z) || state.zones[z]);
    if (zones.length !== receiver.zones.length) {
      receiver.zones = zones;
      structure = true;
    }
    for (const zone of zones) {
      const name = state.zones[zone]?.name;
      if (name && receiver.zoneNames[zone] !== name) {
        receiver.zoneNames[zone] = name;
        structure = true;
      }
    }
    const options = linkInputOptions(state);
    for (const zone of zones) {
      const input = state.zones[zone]?.input;
      if (isInput(input) && !options.some((o) => o.value === input)) {
        options.push({ value: input, label: input });
      }
    }
    if (this.mergeInputs(receiver, options)) {
      structure = true;
    }
    if (structure) {
      this.persist();
    }
    return { receiver, structure };
  }

  /** The dropdown only grows: an input no longer listed keeps its option. True when it changed. */
  mergeInputs(receiver, options) {
    const current = receiver.inputOptions;
    let changed = false;
    for (const option of options) {
      const existing = current.find((o) => o.value === option.value);
      if (existing) {
        if (option.label !== option.value && existing.label !== option.label) {
          existing.label = option.label;
          changed = true;
        }
      } else if (current.length < LIMITS.inputs) {
        current.push({ value: option.value, label: option.label });
        changed = true;
      } else {
        this.warnOnce(`inputs:${addressKey(receiver)}`, `${receiver.model}: too many inputs`);
      }
    }
    return changed;
  }

  /**
   * The input options of the devices created in Gladys (`gladys.devices`,
   * kept up to date by the SDK), merged into the receiver: options seen
   * before a reset of /data are never dropped from a created device.
   */
  mergeCreatedOptions(receiver) {
    const created = Array.isArray(this.gladys.devices) ? this.gladys.devices : [];
    let changed = false;
    for (const zone of receiver.zones) {
      const ids = zoneIds(this.gladys, receiver, zone);
      const device = created.find((d) => d?.external_id === ids.device);
      const feature = (Array.isArray(device?.features) ? device.features : []).find(
        (f) => f?.external_id === ids.feature(FEATURES.SOURCE),
      );
      const options = sanitizeOptions(feature?.supported_options);
      if (this.mergeInputs(receiver, options)) {
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const receivers = this.receivers;
    receivers.forEach((receiver) => this.mergeCreatedOptions(receiver));
    await this.gladys.publishDiscoveredDevices(
      receivers.flatMap((receiver) =>
        receiver.zones.map((zone) => buildDevice(this.gladys, receiver, zone)),
      ),
    );
  }

  /**
   * The devices created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => d?.external_id)
        .filter((id) => typeof id === 'string'),
    );
  }

  // --- States --------------------------------------------------------------------

  /** The states of a zone, grouped: at most one publication per `publishDelay`. */
  schedulePublish(receiver, zone, delay = this.timings.publishDelay) {
    const id = `${addressKey(receiver)}|${zone}`;
    if (this.publishTimers.has(id)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(id));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(id);
      if (generation !== this.generation) {
        return;
      }
      const current = this.data?.receivers[addressKey(receiver)];
      if (current) {
        this.publishStates(current, zone).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(id, handle);
  }

  async publishStates(receiver, zone) {
    if (!this.created.has(zoneIds(this.gladys, receiver, zone).device)) {
      return;
    }
    const states = stateList(this.gladys, receiver, zone, this.zoneState(receiver, zone));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(
        `Could not publish the states of ${deviceName(receiver, zone)}: ${err.message}`,
      );
    }
  }

  async publishAllStates() {
    for (const receiver of this.receivers) {
      for (const zone of receiver.zones) {
        await this.publishStates(receiver, zone);
      }
    }
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(receiver, zone, key, value) {
    if (!featureKeys(zone).includes(key)) {
      throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (
        typeof value !== 'string' ||
        !inputOptions(receiver, zone).some((o) => o.value === value)
      ) {
        throw new Error(`Unknown input "${short(value)}"`);
      }
      return value;
    }
    if (key === FEATURES.SOUND_PROGRAM) {
      if (!isSoundProgram(value)) {
        throw new Error(`Unknown sound program "${short(value)}"`);
      }
      return value;
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const found = this.zoneOf(gladysDevice);
    if (!found) {
      throw new Error(`Unknown device ${short(gladysDevice?.external_id)}`);
    }
    const { receiver, zone, key: receiverKey } = found;
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(receiver, zone, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // Set just before a command line leaves: from then on, it may have
    // reached the receiver, whatever happens next.
    const context = { mayHaveSent: false, sent: 0 };
    const run = this.enqueue(
      receiverKey,
      async () => {
        if (late || this.remaining(started) < 50) {
          // Gladys stopped waiting while this command was queued: dropped, never sent late.
          late = true;
          throw new DeviceError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
        }
        return this.command(receiver, zone, key, checked, started, context);
      },
      { urgent: URGENT.has(key) },
    );
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? new DeviceError(
                  ERROR_KINDS.TIMEOUT,
                  'Sent, without confirmation from the receiver',
                  {
                    sent: true,
                  },
                )
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (receiver busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** The cap of a zone, read now: the option, and the receiver's own limit (`MAXVOL`) when lower. */
  capOf(link, zone) {
    const own = link.state.zones[zone]?.maxVolume;
    return Number.isFinite(own) ? Math.min(this.config.maxVolumeDb, own) : this.config.maxVolumeDb;
  }

  /**
   * Writes one function and confirms it: the answer of the receiver, or a
   * read-back when it gave none. A line that may have reached the receiver
   * is never reported as "not sent".
   */
  async write(link, zone, fn, value, started, context, matches) {
    const budget = Math.min(this.timings.answerTimeout, this.remaining(started));
    if (budget < 50) {
      throw new DeviceError(
        ERROR_KINDS.BUDGET,
        context.sent > 0 ? `No time left: ${fn} not sent` : 'No time left, nothing sent',
      );
    }
    context.mayHaveSent = true;
    let answer;
    try {
      answer = await link.write(zone, fn, value, budget);
    } catch {
      context.mayHaveSent = context.sent > 0;
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        context.sent > 0 ? `Connection lost: ${fn} not sent` : 'Not connected: nothing sent',
        { sent: context.sent > 0 },
      );
    }
    context.sent += 1;
    if (answer.value !== undefined && matches(answer.value)) {
      return;
    }
    if (answer.refused) {
      throw new DeviceError(
        ERROR_KINDS.REFUSED,
        `Refused by the receiver (@${answer.refused.toUpperCase()}): ${fn} not changed`,
        { sent: true },
      );
    }
    if (answer.value !== undefined) {
      throw new DeviceError(
        ERROR_KINDS.TIMEOUT,
        `Sent; the receiver reports ${fn} ${short(answer.value)}`,
        { sent: true },
      );
    }
    // No answer (some receivers do not answer a value already set): read back.
    const left = Math.min(this.timings.answerTimeout, this.remaining(started) - 100);
    if (!answer.closed && left >= 100) {
      const read = await link.read(zone, fn, left).catch(() => ({}));
      if (read.value !== undefined && matches(read.value)) {
        return;
      }
    }
    throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the receiver', {
      sent: true,
    });
  }

  /** A read made before a command line: whatever goes wrong, nothing was sent. */
  async readBefore(link, zone, fn, what, started) {
    const budget = Math.min(this.timings.answerTimeout, this.remaining(started) - 200);
    if (budget < 50) {
      throw new DeviceError(ERROR_KINDS.BUDGET, `No time left to read the ${what}: nothing sent`);
    }
    let answer;
    try {
      answer = await link.read(zone, fn, budget);
    } catch {
      throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent');
    }
    if (answer.value !== undefined) {
      return answer.value;
    }
    if (answer.refused) {
      throw new DeviceError(
        ERROR_KINDS.REFUSED,
        `${what} not readable (@${answer.refused.toUpperCase()}): nothing sent`,
      );
    }
    throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
  }

  async command(receiver, zone, key, value, started, context) {
    const link = this.connectedLink(receiver);
    const name = deviceName(receiver, zone);
    if (!link) {
      // Standby included: a receiver just disconnected may still be on, so
      // "already in standby" would be a guess. Nothing sent, said so.
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${name}: receiver not connected (off without network standby, or unreachable), nothing sent`,
      );
    }
    const write = (fn, text, matches = (v) => v === text) =>
      this.write(link, zone, fn, text, started, context, matches);
    switch (key) {
      case FEATURES.POWER_ON: {
        // A new press starts over: the check chain of the previous one stops.
        this.cancelWakeCheck(this.wakeKey(receiver, zone));
        await write('PWR', POWER.ON);
        // A zone wakes up at the volume it had (or its initial volume):
        // brought back to the cap, within what is left of this command first,
        // then in the background. The ack never depends on it.
        const done = await this.capVolume(receiver, zone, link, () =>
          Math.min(this.timings.answerTimeout, this.remaining(started) - 200),
        ).catch(() => false);
        if (!done) {
          this.capAfterWake(receiver, zone, 1);
        }
        return undefined;
      }
      case FEATURES.STANDBY:
        await write('PWR', POWER.STANDBY);
        return undefined;
      case FEATURES.VOLUME: {
        // The cap is read here, just before the line leaves: a configuration
        // saved while the command waited in the queue applies.
        const cap = this.capOf(link, zone);
        const asked = percentToDb(value);
        const target = stepDb(Math.min(asked, cap));
        if (target < asked) {
          this.logger.info(
            `${name}: volume ${formatDb(asked)} dB capped to ${formatDb(target)} dB`,
          );
        }
        // The receiver may answer a lower value (its own limit): fine, never higher.
        await write('VOL', formatDb(target), (v) => {
          const db = parseDb(v);
          return db !== undefined && db <= target + 0.01;
        });
        return undefined;
      }
      case FEATURES.MUTE: {
        // Gladys sends a press, not a target: the mute is read from the
        // receiver just before, and the opposite is set explicitly (no toggle).
        const muted = parseMute(await this.readBefore(link, zone, 'MUTE', 'mute state', started));
        if (muted === undefined) {
          throw new Error(`${name}: mute state unknown, nothing sent`);
        }
        if (!muted) {
          await write('MUTE', MUTE.ON);
          return undefined;
        }
        // Unmuting never makes the zone play above the cap: the volume read
        // now decides, and is lowered first when above it.
        const volume = parseDb(await this.readBefore(link, zone, 'VOL', 'volume', started));
        if (volume === undefined) {
          throw new Error(`${name}: volume unknown, nothing sent`);
        }
        const cap = this.capOf(link, zone);
        if (volume > cap) {
          this.logger.info(
            `${name}: volume ${formatDb(volume)} dB lowered to ${formatDb(cap)} dB before unmuting`,
          );
          await write('VOL', formatDb(cap), (v) => {
            const db = parseDb(v);
            return db !== undefined && db <= cap + 0.01;
          });
        }
        await write('MUTE', MUTE.OFF);
        return undefined;
      }
      case FEATURES.SOURCE:
        await write('INP', value);
        return undefined;
      case FEATURES.SOUND_PROGRAM:
        await write('SOUNDPRG', value);
        return undefined;
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  wakeKey(receiver, zone) {
    return `${addressKey(receiver)}|${zone}`;
  }

  /**
   * Reads the volume and lowers it to the cap when the zone is on and above
   * it. True when settled (lowered, or nothing to lower), false when the
   * zone cannot tell yet (still waking up) or the budget ran out.
   */
  async capVolume(receiver, zone, link, budget) {
    if (budget() < 50 || !link.connected || link.state.zones[zone]?.power !== true) {
      return false;
    }
    const answer = await link.read(zone, 'VOL', budget());
    const volume = parseDb(answer.value);
    if (volume === undefined) {
      return false;
    }
    const cap = this.capOf(link, zone);
    if (volume <= cap) {
      return true;
    }
    if (budget() < 50) {
      return false;
    }
    this.logger.info(
      `${deviceName(receiver, zone)}: woke up at ${formatDb(volume)} dB, lowered to ${formatDb(cap)} dB`,
    );
    const lowered = await link.write(zone, 'VOL', formatDb(cap), budget());
    const db = parseDb(lowered.value);
    return db !== undefined && db <= cap + 0.01;
  }

  cancelWakeCheck(key) {
    const chain = this.wakeChecks.get(key);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(key);
    }
  }

  /**
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times at most, through the receiver queue. One chain per
   * zone: a new Power on replaces the running one.
   */
  capAfterWake(receiver, zone, attempt, chain = { timer: undefined }) {
    const key = this.wakeKey(receiver, zone);
    if (attempt === 1) {
      this.cancelWakeCheck(key);
      this.wakeChecks.set(key, chain);
    }
    const current = () => this.wakeChecks.get(key) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(key);
      this.logger.info(`${deviceName(receiver, zone)}: volume not confirmed after waking up`);
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(addressKey(receiver), async () => {
        const link = this.connectedLink(receiver);
        if (!link || !current()) {
          return !current();
        }
        return this.capVolume(receiver, zone, link, () => this.timings.answerTimeout);
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(key);
          } else {
            this.capAfterWake(receiver, zone, attempt + 1, chain);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const found = this.zoneOf(gladysDevice);
    if (!found) {
      return;
    }
    this.created.add(gladysDevice.external_id);
    // The SDK forgot what was published for this device: everything again.
    await this.publishStates(found.receiver, found.zone);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    if (typeof gladysDevice?.external_id === 'string') {
      this.created.delete(gladysDevice.external_id);
      await this.updateStatus();
    }
  }

  /** A scan request from the Discovery tab: the devices of the known receivers again. */
  async scan() {
    this.syncLinks({ retry: true });
    await this.publishDevices();
  }

  // --- Configuration screen button ---------------------------------------------------

  async checkReceivers() {
    if (this.config.addresses.length === 0) {
      return T.noReceiver;
    }
    const lines = this.config.addresses.map((address) =>
      T.checkLine(addressKey(address), this.links.get(addressKey(address))),
    );
    return T.check(lines, this.config.maxVolumeDb);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = [];
    const busy = [];
    const off = [];
    for (const address of this.config.addresses) {
      const key = addressKey(address);
      const link = this.links.get(key);
      if (!link || link.connected || !link.lastError) {
        continue;
      }
      const receiver = this.data.receivers[key];
      if (link.busyHint) {
        busy.push(key);
      } else if (receiver) {
        off.push(`${receiver.model ?? 'Yamaha'} (${key})`);
      } else {
        silent.push(key);
      }
    }
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    if (busy.length > 0) {
      notes.push(T.busy(busy));
    }
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
