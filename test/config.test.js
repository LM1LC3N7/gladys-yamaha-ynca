import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressSlug, normalizeConfig, parseAddress, parseMaxVolumeDb } from '../src/config.js';
import { sanitizeData } from '../src/store.js';

test('addresses: IPv4 or host name, port 50000 by default', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 50000 });
  assert.deepEqual(parseAddress(' 192.168.1.50:50001 '), { host: '192.168.1.50', port: 50001 });
  assert.deepEqual(parseAddress('tcp://Ampli.local:50000/x'), { host: 'ampli.local', port: 50000 });
  for (const raw of [
    '',
    '999.1.1.1',
    '1.2.3',
    'a b',
    'host:0',
    'host:70000',
    'host:x',
    ':50000',
    '-a.b',
  ]) {
    assert.equal(parseAddress(raw), undefined, raw);
  }
  assert.equal(addressSlug({ host: '192.168.1.50', port: 50000 }), '192-168-1-50');
  assert.equal(addressSlug({ host: 'ampli.local', port: 50001 }), 'ampli-local-50001');
});

test('the configuration: deduplicated addresses, ten at most, invalid ones listed', () => {
  const many = Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`).join(', ');
  const config = normalizeConfig({ addresses: `10.0.0.1, 10.0.0.1:50000; bad!, ${many}` });
  assert.equal(config.addresses.length, 10);
  assert.deepEqual(config.invalid, ['bad!', '10.0.0.11', '10.0.0.12']);
  // Two addresses sharing an external-id slug: the second one is refused.
  const slugs = normalizeConfig({ addresses: 'amp.lan, amp-lan, 192.168.1.50, 192-168-1-50' });
  assert.deepEqual(
    slugs.addresses.map((a) => a.host),
    ['amp.lan', '192.168.1.50'],
  );
  assert.deepEqual(slugs.invalid, ['amp-lan', '192-168-1-50']);
  assert.equal(normalizeConfig().maxVolumeDb, -20);
  assert.equal(normalizeConfig(null).addresses.length, 0);
});

test('the volume cap: -80..+16.5 dB on the 0.5 step, default when unreadable', () => {
  assert.equal(parseMaxVolumeDb(-30), -30);
  assert.equal(parseMaxVolumeDb('-30.3'), -30.5);
  assert.equal(parseMaxVolumeDb(-100), -80);
  assert.equal(parseMaxVolumeDb(40), 16.5);
  for (const raw of [undefined, null, '', 'abc', true, NaN, Infinity, {}]) {
    assert.equal(parseMaxVolumeDb(raw), -20, String(raw));
  }
});

test('/data is checked again when read: no prototype, only valid entries', () => {
  const data = sanitizeData(
    JSON.parse(
      JSON.stringify({
        receivers: {
          '10.0.0.1': {
            host: '10.0.0.1',
            port: 50000,
            model: 'RX-A1020',
            zones: ['MAIN', 'ZONE9', '__proto__'],
            zoneNames: { MAIN: 'Salon', ZONE9: 'x' },
            inputOptions: [{ value: 'HDMI1', label: 'TV' }, { value: '__proto__' }, 'x'],
          },
          '10.0.0.2': { host: '10.0.0.3', port: 50000 },
          __proto__: { host: 'x' },
        },
      }),
    ),
  );
  assert.equal(Object.getPrototypeOf(data.receivers), null);
  assert.deepEqual(Object.keys(data.receivers), ['10.0.0.1']);
  const receiver = data.receivers['10.0.0.1'];
  assert.deepEqual(receiver.zones, ['MAIN']);
  assert.deepEqual({ ...receiver.zoneNames }, { MAIN: 'Salon' });
  assert.deepEqual(receiver.inputOptions, [{ value: 'HDMI1', label: 'TV' }]);
  assert.deepEqual(sanitizeData('junk'), { receivers: Object.create(null) });
});
