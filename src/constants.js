// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <address slug>-<zone>)`. */
export const DEVICE_TYPE = 'ynca';

/** The zones of a receiver, as YNCA names them (subunits), in their frozen order. */
export const ZONES = Object.freeze(['MAIN', 'ZONE2', 'ZONE3', 'ZONE4']);

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or receiver unreachable). */
  POWER: 'power',
  /** Push button: turns the zone on. */
  POWER_ON: 'power_on',
  /** Push button: puts the zone in standby. */
  STANDBY: 'standby',
  /** 0..100 (-80.5 dB .. +16.5 dB), capped by the `max_volume_db` option. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the receiver. */
  MUTE: 'mute',
  /** Dropdown: the input of the zone. */
  SOURCE: 'source',
  /** Dropdown: the sound program (DSP) of the main zone. Main zone only. */
  SOUND_PROGRAM: 'sound_program',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_receivers',
});

/** The YNCA port of every receiver (the network control port of Yamaha). */
export const DEFAULT_PORT = 50000;

/**
 * The volume of a zone in dB, as YNCA gives and takes it (`@MAIN:VOL=-30.5`):
 * -80.5 to +16.5 in steps of 0.5 (the `MIN_VOLUME` / `MAX_VOLUME` of ynca).
 * Gladys shows it as 0..100, linearly: 0 = -80.5 dB, 100 = +16.5 dB.
 */
export const VOLUME_DB = Object.freeze({ min: -80.5, max: 16.5, step: 0.5 });

/** The volume cap of the configuration, in dB. */
export const MAX_VOLUME_DB = Object.freeze({ min: -80, max: 16.5, default: -20 });

export const TIMINGS = Object.freeze({
  /** Opening the TCP connection. */
  connectTimeout: 5_000,
  /**
   * The YNCA specification asks for 100 ms at least between two commands
   * (ynca `COMMAND_SPACING`): every line sent waits for it.
   */
  commandSpacing: 100,
  /**
   * The snapshot read after connecting ends with `@SYS:VERSION=?`; its answer
   * is awaited `initBase` plus `initPerCommand` per command sent (ynca: 2 s +
   * 5 × the spacing per command, for slow receivers).
   */
  initBase: 2_000,
  initPerCommand: 500,
  /**
   * A receiver drops an idle connection after 40 s (YNCA specification): a
   * `@SYS:MODELNAME=?` every 30 s keeps it open (as ynca). No line at all
   * within `silenceTimeout` closes the connection.
   */
  keepAlive: 30_000,
  silenceTimeout: 45_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-receiver queue and every line included) gets `commandBudget`; the
   * answer of one line is awaited `answerTimeout` at most.
   */
  commandBudget: 3_500,
  answerTimeout: 1_200,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /** After a Power on whose volume could not be checked in the budget: again every `wakeCheckDelay`, `wakeChecks` times. */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  /** The states of one zone are published at most this often (a knob turned fast). */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
  /** More lines than this within `floodWindow`: the connection is closed. */
  floodLines: 600,
  floodWindow: 10_000,
});

export const LIMITS = Object.freeze({
  receivers: 10,
  /** Length of one received line; a longer one is dropped. */
  lineBytes: 512,
  /** Bytes received without an end of line: the connection is closed above. */
  bufferBytes: 4_096,
  /** Lines waiting to be sent on one connection. */
  sendQueue: 64,
  /** Inputs of one receiver. */
  inputs: 60,
  /** Length of a name (model, zone, input). */
  name: 64,
});
