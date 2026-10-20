// -----------------------------------------------------------------------------
// The persistent link with the receiver at one address: the TCP session
// opened, the snapshot read (model, zones, inputs, then power, volume, mute,
// input and sound program of each zone, as ynca's initialize()), the pushed
// lines merged, a keep-alive every 30 s, and the reconnection spaced out (10 s,
// then doubled each time up to 5 minutes; the count is only reset by a
// connection that stayed up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, TIMINGS, ZONES } from '../constants.js';
import { DeviceError, ERROR_KINDS, openSession } from './connection.js';
import {
  SUBUNIT_INPUTS,
  cleanText,
  getLine,
  formatLine,
  inputOfInpname,
  isInput,
  isSoundProgram,
  parseDb,
  parseLine,
  parseMute,
  parsePower,
} from './protocol.js';

const ZONE_SET = new Set(ZONES);
const INPUT_SUBUNITS = new Set(Object.keys(SUBUNIT_INPUTS));

export const emptyState = () => ({
  model: undefined,
  /** zone -> { power, volume (dB), mute, input, soundProgram, maxVolume (dB), name } */
  zones: Object.create(null),
  /** The input subunits that answered `AVAIL` (their inputs exist). */
  inputSubunits: new Set(),
  /** input -> name given on the receiver (`@SYS:INPNAME…`). */
  inputNames: new Map(),
});

/** The lines of the snapshot, in order (the end marker last). */
export function snapshotLines() {
  return [
    // A receiver in low power mode loses the first line (ynca sends two keep-alives).
    getLine('SYS', 'MODELNAME'),
    getLine('SYS', 'MODELNAME'),
    ...ZONES.map((zone) => getLine(zone, 'AVAIL')),
    ...[...INPUT_SUBUNITS].map((subunit) => getLine(subunit, 'AVAIL')),
    getLine('SYS', 'INPNAME'),
    ...ZONES.flatMap((zone) => [
      getLine(zone, 'BASIC'),
      getLine(zone, 'MAXVOL'),
      getLine(zone, 'ZONENAME'),
    ]),
    // The end marker (ynca uses it the same way).
    getLine('SYS', 'VERSION'),
  ];
}

/**
 * Applies one parsed `ok` line to `state`. Returns the zone it changed, 'SYS'
 * for the model or the inputs, or undefined when nothing kept changed.
 */
export function applyLine(state, { subunit, fn, value }) {
  if (subunit === 'SYS') {
    if (fn === 'MODELNAME') {
      const model = cleanText(value, LIMITS.name);
      if (model && model !== state.model) {
        state.model = model;
        return 'SYS';
      }
      return undefined;
    }
    const input = inputOfInpname(fn);
    if (input) {
      const name = cleanText(value, LIMITS.name) ?? input;
      if (state.inputNames.get(input) !== name && state.inputNames.size < LIMITS.inputs) {
        state.inputNames.set(input, name);
        return 'SYS';
      }
    }
    return undefined;
  }
  if (INPUT_SUBUNITS.has(subunit)) {
    if (fn === 'AVAIL' && !state.inputSubunits.has(subunit)) {
      state.inputSubunits.add(subunit);
      return 'SYS';
    }
    return undefined;
  }
  if (!ZONE_SET.has(subunit)) {
    return undefined;
  }
  const zone = state.zones[subunit] ?? (state.zones[subunit] = {});
  const before = JSON.stringify(zone);
  switch (fn) {
    case 'AVAIL':
      break;
    case 'PWR':
      zone.power = parsePower(value);
      break;
    case 'VOL':
      zone.volume = parseDb(value);
      break;
    case 'MAXVOL':
      zone.maxVolume = parseDb(value);
      break;
    case 'MUTE':
      zone.mute = parseMute(value);
      break;
    case 'INP':
      zone.input = isInput(value) ? value : undefined;
      break;
    case 'SOUNDPRG':
      zone.soundProgram = isSoundProgram(value) ? value : undefined;
      break;
    case 'ZONENAME':
      zone.name = cleanText(value, LIMITS.name);
      break;
    default:
      return undefined;
  }
  return JSON.stringify(zone) === before ? undefined : subunit;
}

export class ReceiverLink {
  constructor({
    address,
    onEvent = () => {},
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = Date.now,
    createSocket,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.createSocket = createSocket;
    this.session = undefined;
    this.connecting = false;
    this.stopped = false;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttempt = -Infinity;
    this.lastLineAt = 0;
    this.retryTimer = undefined;
    this.keepAliveTimer = undefined;
    this.lines = [];
    /** Waiting for an answer: { subunit, fn, resolve, timer }. */
    this.waiters = [];
    /** The end marker of the snapshot. */
    this.snapshotDone = undefined;
    /** The last error of a connection attempt (shown by "Check"). */
    this.lastError = undefined;
    /** A connection that opened, then closed at once or never answered: another client may hold the port. */
    this.busyHint = false;
    this.state = emptyState();
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  get connected() {
    return Boolean(this.session?.open) && this.connectedAt !== undefined;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopKeepAlive();
    const session = this.session;
    this.session = undefined;
    session?.close();
    this.settleWaiters({ closed: true });
  }

  /** A reconnection asked now (configuration saved): skips the backoff, never the base interval. */
  retrySoon() {
    if (this.stopped || this.connected || this.connecting) {
      return;
    }
    const wait = Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now());
    this.schedule(wait);
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, ms);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return Math.min(
      this.timings.reconnectMax,
      this.timings.reconnectBase * 2 ** Math.min(this.failures - 1, 16),
    );
  }

  async connect() {
    if (this.stopped || this.connecting || this.session) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let session;
    let opened = false;
    try {
      session = await openSession({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeout,
        spacing: this.timings.commandSpacing,
        createSocket: this.createSocket,
        onLine: (line) => this.receive(session, line),
        onClose: () => this.closed(session),
      });
      opened = true;
      if (this.stopped) {
        session.close();
        return;
      }
      this.session = session;
      await this.readSnapshot(session);
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.busyHint = false;
      this.startKeepAlive(session);
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      // Opened, then closed or silent: the YNCA port may be held by another client.
      this.busyHint = opened;
      if (session) {
        this.session = undefined;
        session.onClose = () => {};
        session.close();
      }
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  async readSnapshot(session) {
    const state = emptyState();
    this.state = state;
    const lines = snapshotLines();
    const done = new Promise((resolve) => {
      this.snapshotDone = resolve;
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        this.timings.initBase + lines.length * this.timings.initPerCommand,
      );
    });
    // Closed while reading: the session send rejects.
    const sent = Promise.all(lines.map((line) => session.send(line))).then(
      () => new Promise(() => {}),
    );
    const closed = new Promise((resolve) => {
      session.onSnapshotClose = () => resolve(false);
    });
    try {
      const ok = await Promise.race([done, timeout, sent, closed]);
      if (!ok) {
        throw new DeviceError(ERROR_KINDS.PROTOCOL, 'No complete answer from the receiver');
      }
    } finally {
      clearTimeout(timer);
      this.snapshotDone = undefined;
      session.onSnapshotClose = undefined;
    }
    if (!state.model) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not a YNCA receiver (no model name)');
    }
  }

  receive(session, line) {
    if (session !== this.session) {
      return;
    }
    if (this.flooded(session)) {
      return;
    }
    this.lastLineAt = this.now();
    const parsed = parseLine(line);
    if (!parsed) {
      return;
    }
    if (parsed.status !== 'ok') {
      // A refused line: the oldest one waiting for an answer (the receiver answers in order).
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve({ refused: parsed.status });
      }
      return;
    }
    const changed = applyLine(this.state, parsed);
    if (parsed.subunit === 'SYS' && parsed.fn === 'VERSION' && this.snapshotDone) {
      this.snapshotDone(true);
    }
    for (const waiter of this.waiters.filter(
      (w) => w.subunit === parsed.subunit && w.fn === parsed.fn,
    )) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve({ value: parsed.value });
    }
    if (changed && this.connectedAt !== undefined) {
      this.onEvent('update', this, changed);
    }
  }

  /** Every line counts, before parsing: a receiver flooding the connection is closed. */
  flooded(session) {
    const now = this.now();
    this.lines.push(now);
    while (this.lines.length > 0 && now - this.lines[0] > this.timings.floodWindow) {
      this.lines.shift();
    }
    if (this.lines.length > this.timings.floodLines) {
      this.logger?.warn?.(`${this.key}: too many lines, connection closed`);
      this.lines = [];
      session.close();
      return true;
    }
    return false;
  }

  closed(session) {
    // Closed before the session was known (refused at once): connect() handles it.
    session?.onSnapshotClose?.();
    if (!session || session !== this.session) {
      return;
    }
    this.session = undefined;
    this.stopKeepAlive();
    this.settleWaiters({ closed: true });
    if (this.stopped || this.connectedAt === undefined) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  settleWaiters(result) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
  }

  startKeepAlive(session) {
    this.stopKeepAlive();
    this.lastLineAt = this.now();
    this.keepAliveTimer = this.timers.setInterval(() => {
      if (session !== this.session) {
        return;
      }
      if (this.now() - this.lastLineAt > this.timings.silenceTimeout) {
        this.logger?.info?.(`${this.key}: no answer to the keep-alive, connection closed`);
        session.close();
        return;
      }
      session.send(getLine('SYS', 'MODELNAME')).catch(() => {});
    }, this.timings.keepAlive);
  }

  stopKeepAlive() {
    this.timers.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  /**
   * Sends one line and waits for its answer: the next line of the same
   * subunit and function (`{ value }`), a refusal (`{ refused }`), the end of
   * `timeoutMs` (`{ timeout: true }`) or the end of the connection (`{ closed:
   * true }`). Throws a DeviceError UNREACHABLE when the line could not be
   * written (nothing sent).
   */
  async exchange(subunit, fn, value, timeoutMs) {
    if (!this.connected) {
      throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent');
    }
    const line = formatLine(subunit, fn, value);
    let waiter;
    const answer = new Promise((resolve) => {
      waiter = { subunit, fn, resolve };
      waiter.timer = setTimeout(
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          resolve({ timeout: true });
        },
        Math.max(0, timeoutMs),
      );
    });
    this.waiters.push(waiter);
    try {
      await this.session.send(line);
    } catch (err) {
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) {
        this.waiters.splice(index, 1);
      }
      clearTimeout(waiter.timer);
      throw err;
    }
    return answer;
  }

  /** Reads one function (`?`). */
  read(subunit, fn, timeoutMs) {
    return this.exchange(subunit, fn, '?', timeoutMs);
  }

  /** Writes one function. */
  write(subunit, fn, value, timeoutMs) {
    return this.exchange(subunit, fn, value, timeoutMs);
  }
}
