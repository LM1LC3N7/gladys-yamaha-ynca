// -----------------------------------------------------------------------------
// YncaApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake YNCA receiver on the loopback
// interface. The background round and the keep-alive never fire: the tests
// drive them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YncaApp, parseVolumeCommand } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { startFakeReceiver } from './fixtures/fakeReceiver.js';

const SELECTOR = 'yamaha-ynca';

/** No background round, no keep-alive; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  commandSpacing: 5,
  initBase: 500,
  initPerCommand: 20,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  publishDelay: 5,
  persistDelay: 5,
  wakeCheckDelay: 30,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, { receiver, config, timings = {}, store = new MemoryStore() } = {}) {
  const fake = await startFakeReceiver(receiver);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${fake.port}` },
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new YncaApp({ gladys, logger, store, timers, timings: { ...FAST, ...timings } });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  const slug = `127-0-0-1-${fake.port}`;
  const id = (zone, key) =>
    `ext:${SELECTOR}:ynca:${slug}-${zone.toLowerCase()}${key ? `:${key}` : ''}`;
  return { fake, gladys, app, logs, store, id };
}

async function discovered(gladys, id, zone = 'MAIN') {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(zone)),
    `the ${zone} device in the Discovery tab`,
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(zone));
}

async function createDevice(gladys, id, zone = 'MAIN') {
  const device = await discovered(gladys, id, zone);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id(zone, 'power')) !== undefined, 'the power state');
  return device;
}

const set = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === `${device.external_id}:${key}`),
    value,
  );

test('a typed address gives one Gladys device per zone; states once created', async (t) => {
  const { gladys, id } = await setup(t);
  const main = await discovered(gladys, id, 'MAIN');
  const zone2 = await discovered(gladys, id, 'ZONE2');
  assert.equal(gladys.fake.discoveredDevices.length, 2, 'only the zones that answer');
  assert.equal(main.name, 'Living (RX-V673 Main zone)');
  assert.equal(zone2.name, 'RX-V673 Zone 2');
  assert.deepEqual(main.params, [
    { name: 'IP_ADDRESS', value: '127.0.0.1' },
    { name: 'ZONE', value: 'MAIN' },
  ]);
  const keys = (d) => d.features.map((f) => f.external_id.split(':').pop());
  assert.deepEqual(keys(main), [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'source',
    'sound_program',
  ]);
  assert.deepEqual(keys(zone2), ['power', 'power_on', 'standby', 'volume', 'mute', 'source']);
  const byKey = Object.fromEntries(main.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok([...main.features, ...zone2.features].every((f) => f.category !== 'switch'));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.volume.category, byKey.volume.type], ['music', 'volume']);
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual(byKey.source.supported_options, [
    { value: 'AV1', label: 'TV (AV1)' },
    { value: 'HDMI1', label: 'Blu-ray (HDMI1)' },
    { value: 'HDMI2', label: 'HDMI2' },
    { value: 'MULTI CH', label: 'MULTI CH' },
    { value: 'NET RADIO', label: 'NET RADIO' },
    { value: 'TUNER', label: 'TUNER' },
    { value: 'USB', label: 'USB' },
  ]);
  assert.ok(byKey.sound_program.supported_options.some((o) => o.value === '7ch Stereo'));
  const zone2Source = zone2.features.find((f) => f.external_id.endsWith(':source'));
  assert.equal(zone2Source.supported_options.at(-1).value, 'Main Zone Sync');
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createDevice(gladys, id, 'MAIN');
  await waitFor(() => gladys.fake.lastState(id('MAIN', 'sound_program')), 'the sound program');
  assert.equal(gladys.fake.lastState(id('MAIN', 'power')), 1);
  // -35 dB on -80.5..+16.5: 47 %.
  assert.equal(gladys.fake.lastState(id('MAIN', 'volume')), 47);
  assert.equal(gladys.fake.lastState(id('MAIN', 'mute')), 0);
  assert.equal(gladys.fake.lastState(id('MAIN', 'source')), 'HDMI1');
  assert.equal(gladys.fake.lastState(id('MAIN', 'sound_program')), 'Standard');
  await createDevice(gladys, id, 'ZONE2');
  assert.equal(gladys.fake.lastState(id('ZONE2', 'power')), 0);
  assert.equal(gladys.fake.lastState(id('ZONE2', 'source')), 'NET RADIO');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.connectionStatus.message, undefined);
});

test('the lines are 100 ms apart at least (YNCA specification)', async (t) => {
  const { fake } = await setup(t, { timings: { commandSpacing: 100, initPerCommand: 200 } });
  await waitFor(() => fake.lines.length >= 12, 'twelve lines');
  const gaps = fake.lines.slice(1).map((l, i) => l.at - fake.lines[i].at);
  assert.ok(gaps.length >= 11);
  assert.ok(Math.min(...gaps) >= 90, `smallest gap ${Math.min(...gaps)} ms`);
});

test('the volume is capped by the option, read just before sending', async (t) => {
  const { fake, gladys, app, id } = await setup(t);
  const main = await createDevice(gladys, id);
  // 100 % is +16.5 dB: the default cap is -20 dB.
  assert.deepEqual(await set(gladys, main, 'volume', 100), { success: true });
  assert.equal(fake.writes().at(-1), '@MAIN:VOL=-20.0');
  await waitFor(() => gladys.fake.lastState(id('MAIN', 'volume')) === 62, 'the capped volume');
  // Below the cap: sent as asked, on the 0.5 dB step.
  assert.deepEqual(await set(gladys, main, 'volume', '30'), { success: true });
  assert.equal(fake.writes().at(-1), '@MAIN:VOL=-51.5');
  // A new cap applies at once.
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume_db: -40 });
  assert.equal(app.config.maxVolumeDb, -40);
  await set(gladys, main, 'volume', 80);
  assert.equal(fake.writes().at(-1), '@MAIN:VOL=-40.0');
  // Refused before anything is sent.
  const before = fake.writes().length;
  for (const value of [null, '', true, 12.5, '12abc', -1, 101, NaN]) {
    const ack = await set(gladys, main, 'volume', value);
    assert.equal(ack.success, false, String(value));
  }
  assert.equal(fake.writes().length, before, 'nothing sent');
});

test("the receiver's own limit (MAXVOL) also caps", async (t) => {
  const { fake, gladys, id } = await setup(t, {
    config: { addresses: '', max_volume_db: 16.5 },
  });
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume_db: 16.5 });
  const zone2 = await createDevice(gladys, id, 'ZONE2');
  await set(gladys, zone2, 'volume', 100);
  assert.equal(fake.writes().at(-1), '@ZONE2:VOL=0.0');
});

test('mute: each press sets the opposite of the mute read; unmuting lowers the volume first', async (t) => {
  const { fake, gladys, id } = await setup(t);
  const main = await createDevice(gladys, id);
  assert.deepEqual(await set(gladys, main, 'mute'), { success: true });
  assert.equal(fake.writes().at(-1), '@MAIN:MUTE=On');
  // Muted with the volume above the cap (turned up on the receiver meanwhile).
  fake.state.zones.MAIN.VOL = '-5.0';
  fake.push('@MAIN:VOL=-5.0');
  fake.state.zones.MAIN.MUTE = 'Att -20 dB';
  assert.deepEqual(await set(gladys, main, 'mute'), { success: true });
  assert.deepEqual(fake.writes().slice(-2), ['@MAIN:VOL=-20.0', '@MAIN:MUTE=Off']);
  // A volume set on the receiver itself is shown, not lowered while it plays.
  fake.state.zones.MAIN.VOL = '-10.0';
  fake.push('@MAIN:VOL=-10.0');
  await waitFor(() => gladys.fake.lastState(id('MAIN', 'volume')) === 73, 'the pushed volume');
  assert.equal(fake.writes().at(-1), '@MAIN:MUTE=Off');
});

test('Power on: the zone woken up above the cap is brought back to it', async (t) => {
  const { fake, gladys, id } = await setup(t, { receiver: { wakeVolume: '-3.0' } });
  const zone2 = await createDevice(gladys, id, 'ZONE2');
  assert.deepEqual(await set(gladys, zone2, 'power_on'), { success: true });
  assert.deepEqual(fake.writes().slice(-2), ['@ZONE2:PWR=On', '@ZONE2:VOL=-20.0']);
  await waitFor(() => gladys.fake.lastState(id('ZONE2', 'power')) === 1, 'the power on');
  assert.deepEqual(await set(gladys, zone2, 'standby'), { success: true });
  assert.equal(fake.writes().at(-1), '@ZONE2:PWR=Standby');
  await waitFor(() => gladys.fake.lastState(id('ZONE2', 'power')) === 0, 'the standby');
});

test('input and sound program: checked, refused by the receiver said so', async (t) => {
  const { fake, gladys, id } = await setup(t, { receiver: { restricted: new Set(['SOUNDPRG']) } });
  const main = await createDevice(gladys, id);
  assert.deepEqual(await set(gladys, main, 'source', 'HDMI2'), { success: true });
  assert.equal(fake.writes().at(-1), '@MAIN:INP=HDMI2');
  const before = fake.writes().length;
  const unknown = await set(gladys, main, 'source', 'HDMI9');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /Unknown input/);
  const sync = await set(gladys, main, 'source', 'Main Zone Sync');
  assert.equal(sync.success, false, 'Main Zone Sync is for zones 2 to 4');
  const bad = await set(gladys, main, 'sound_program', '@MAIN:PWR=Standby');
  assert.equal(bad.success, false);
  assert.equal(fake.writes().length, before, 'nothing sent');
  const refused = await set(gladys, main, 'sound_program', 'Hall in Vienna');
  assert.equal(refused.success, false);
  assert.match(refused.error, /Refused by the receiver \(@RESTRICTED\)/);
});

test('no answer to a write: read back, then "sent, without confirmation"', async (t) => {
  const { fake, gladys, id } = await setup(t, {
    receiver: { echoUnchanged: false },
    timings: { answerTimeout: 200 },
  });
  const main = await createDevice(gladys, id);
  // Already HDMI1: the receiver answers nothing, the read-back confirms it.
  assert.deepEqual(await set(gladys, main, 'source', 'HDMI1'), { success: true });
  assert.deepEqual(
    fake.lines.slice(-2).map((l) => l.line),
    ['@MAIN:INP=HDMI1', '@MAIN:INP=?'],
  );
  // Silent from now on: sent, never "not sent".
  fake.cfg.silent = true;
  const ack = await set(gladys, main, 'source', 'HDMI2');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
});

test('a receiver that does not answer: nothing sent, said so; power 0', async (t) => {
  const { fake, gladys, app, id } = await setup(t);
  const main = await createDevice(gladys, id);
  await fake.close();
  await waitFor(() => gladys.fake.lastState(id('MAIN', 'power')) === 0, 'power 0');
  const ack = await set(gladys, main, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing sent/);
  await app.tick();
  assert.match(gladys.fake.connectionStatus.message.en, /Not connected/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Non connectés/);
  // The zones stay in the Discovery tab, from /data.
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

test('a port held by another client is said in the status', async (t) => {
  const { gladys } = await setup(t, { receiver: { closeOnConnect: true } });
  await waitFor(
    () => /Home Assistant/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the busy note',
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /Home Assistant/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('a silent port: no device, said in the status', async (t) => {
  const { gladys } = await setup(t, { receiver: { silent: true } });
  await waitFor(() => gladys.fake.connectionStatus?.message, 'a status note');
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer|No YNCA receiver/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('a reconnection to Gladys keeps the connection to the receiver', async (t) => {
  const { fake, gladys, id } = await setup(t);
  await createDevice(gladys, id);
  const connections = fake.connections;
  await gladys.disconnect();
  await gladys.connect();
  await settle(100);
  assert.equal(fake.connections, connections);
  assert.equal(gladys.fake.lastState(id('MAIN', 'power')), 1, 'states published again');
});

test('a restart with the receiver off still publishes its zones (from /data)', async (t) => {
  const first = await setup(t);
  await discovered(first.gladys, first.id, 'ZONE2');
  await settle(50);
  const saved = first.store.data;
  assert.deepEqual(saved.receivers[`127.0.0.1:${first.fake.port}`].zones, ['MAIN', 'ZONE2']);
  const port = first.fake.port;
  await first.fake.close();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: `127.0.0.1:${port}` },
  });
  const app = new YncaApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store: new MemoryStore(saved),
    timers,
    timings: FAST,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    ['Living (RX-V673 Main zone)', 'RX-V673 Zone 2'],
  );
  const main = gladys.fake.discoveredDevices[0];
  assert.equal(
    main.features.find((f) => f.external_id.endsWith(':source')).supported_options.length,
    7,
  );
});

test('"Check the receivers" says what each one answers', async (t) => {
  const { gladys, id } = await setup(t);
  await discovered(gladys, id);
  const ack = await gladys.fake.action('check_receivers');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /connected, RX-V673; Main zone on, volume -35\.0 dB/);
  assert.match(ack.data.message.en, /Volume cap: -20\.0 dB/);
  assert.match(ack.data.message.fr, /zone principale allumée/);
});

test('hostile lines: unknown values ignored, endless line closes the connection', async (t) => {
  const { fake, gladys, id } = await setup(t);
  await createDevice(gladys, id);
  fake.push('@MAIN:INP=__proto__');
  fake.push('@SYS:INPNAME__proto__=x');
  fake.push('@MAIN:VOL=-999.0');
  fake.push('garbage');
  await settle(50);
  assert.equal(gladys.fake.lastState(id('MAIN', 'volume')), 47);
  assert.equal({}.x, undefined);
  const connections = fake.connections;
  fake.raw('A'.repeat(5_000));
  await waitFor(() => fake.connections > connections, 'a new connection after the close');
});

test('a command waiting past its deadline is dropped, never sent late', async (t) => {
  const { fake, gladys, id } = await setup(t, {
    timings: { commandBudget: 300, answerTimeout: 250 },
  });
  const main = await createDevice(gladys, id);
  fake.cfg.silent = true;
  const results = await Promise.all([
    set(gladys, main, 'source', 'HDMI2'),
    set(gladys, main, 'source', 'AV1'),
  ]);
  assert.ok(results.every((r) => r.success === false));
  await settle(400);
  assert.ok(!fake.writes().includes('@MAIN:INP=AV1'), 'the second never left');
});

test('parseVolumeCommand is strict', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand('42'), 42);
  for (const value of [null, '', true, 12.5, '12abc', -1, 101, NaN, undefined, {}]) {
    assert.equal(parseVolumeCommand(value), undefined, String(value));
  }
});
