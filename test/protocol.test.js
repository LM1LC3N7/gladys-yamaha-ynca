import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbToPercent,
  formatDb,
  formatLine,
  inputOfInpname,
  parseDb,
  parseLine,
  parseMute,
  parsePower,
  percentToDb,
} from '../src/ynca/protocol.js';
import { applyLine, emptyState } from '../src/ynca/link.js';

test('lines are parsed as ynca does: first colon, first equals sign after it', () => {
  assert.deepEqual(parseLine('@MAIN:VOL=-30.5'), {
    status: 'ok',
    subunit: 'MAIN',
    fn: 'VOL',
    value: '-30.5',
  });
  assert.deepEqual(parseLine('@SYS:INPNAMEHDMI1=A=B:C').value, 'A=B:C');
  assert.deepEqual(parseLine('@MAIN:3DCINEMA=Auto').fn, '3DCINEMA');
  assert.deepEqual(parseLine('@MAIN:VOL='), {
    status: 'ok',
    subunit: 'MAIN',
    fn: 'VOL',
    value: '',
  });
  assert.deepEqual(parseLine('@UNDEFINED'), { status: 'undefined' });
  assert.deepEqual(parseLine('@RESTRICTED'), { status: 'restricted' });
  for (const line of [
    '',
    'MAIN:VOL=1',
    '@:VOL=1',
    '@MAIN:=1',
    '@MAIN',
    '@main:vol=1',
    '@MA IN:VOL=1',
  ]) {
    assert.equal(parseLine(line), undefined, line);
  }
  // Linear: a long hostile line parses at once.
  const start = Date.now();
  parseLine(`@${'A'.repeat(100_000)}`);
  parseLine(`@A:${'='.repeat(100_000)}`);
  assert.ok(Date.now() - start < 100);
});

test('lines sent are plain YNCA lines only', () => {
  assert.equal(formatLine('MAIN', 'VOL', '-20.0'), '@MAIN:VOL=-20.0');
  assert.equal(formatLine('MAIN', 'SOUNDPRG', 'Recital/Opera'), '@MAIN:SOUNDPRG=Recital/Opera');
  for (const [s, f, v] of [
    ['MAIN', 'INP', 'HDMI1\r\n@MAIN:PWR=Standby'],
    ['MAIN', 'INP', '@x'],
    ['MAIN', 'INP', ''],
    ['main', 'INP', 'x'],
    ['MAIN', 'IN P', 'x'],
  ]) {
    assert.throws(() => formatLine(s, f, v));
  }
});

test('volume: dB on the 0.5 step, 0..100 linear on -80.5..+16.5', () => {
  assert.equal(parseDb('-30.5'), -30.5);
  assert.equal(parseDb('16.5'), 16.5);
  assert.equal(parseDb('0'), 0);
  for (const text of ['-81.0', '17.0', '1e1', ' 1', '--1', '', 'Up', undefined]) {
    assert.equal(parseDb(text), undefined, String(text));
  }
  assert.equal(formatDb(-30.25), '-30.0');
  assert.equal(formatDb(-0.2), '0.0');
  assert.equal(formatDb(-20), '-20.0');
  assert.equal(formatDb(99), '16.5');
  assert.equal(percentToDb(0), -80.5);
  assert.equal(percentToDb(100), 16.5);
  assert.equal(percentToDb(50), -32);
  assert.equal(dbToPercent(-80.5), 0);
  assert.equal(dbToPercent(16.5), 100);
  for (let p = 0; p <= 100; p += 1) {
    assert.equal(dbToPercent(percentToDb(p)), p, `round trip of ${p}`);
  }
});

test('power, mute and input names', () => {
  assert.equal(parsePower('On'), true);
  assert.equal(parsePower('Standby'), false);
  assert.equal(parsePower('on'), undefined);
  assert.equal(parseMute('Off'), false);
  assert.equal(parseMute('On'), true);
  assert.equal(parseMute('Att -40 dB'), true);
  assert.equal(parseMute('x'), undefined);
  assert.equal(inputOfInpname('INPNAMEHDMI3'), 'HDMI3');
  assert.equal(inputOfInpname('INPNAMEMULTICH'), 'MULTI CH');
  assert.equal(inputOfInpname('INPNAMEVAUX'), 'V-AUX');
  assert.equal(inputOfInpname('INPNAME'), undefined);
  assert.equal(inputOfInpname('INPNAMEconstructor'), undefined);
  assert.equal(inputOfInpname('INPNAME__proto__'), undefined);
});

test('applyLine keeps only known zones, functions and values', () => {
  const state = emptyState();
  // A zone exists only once it answered AVAIL: any other line never creates it.
  assert.equal(applyLine(state, parseLine('@ZONE4:SCENE1NAME=x')), undefined);
  assert.equal(applyLine(state, parseLine('@ZONE4:PWR=On')), undefined);
  assert.ok(!('ZONE4' in state.zones));
  assert.equal(applyLine(state, parseLine('@MAIN:AVAIL=Ready')), 'MAIN');
  assert.equal(applyLine(state, parseLine('@MAIN:PWR=On')), 'MAIN');
  assert.equal(applyLine(state, parseLine('@MAIN:PWR=On')), undefined, 'unchanged');
  assert.equal(applyLine(state, parseLine('@ZONE9:PWR=On')), undefined);
  assert.equal(applyLine(state, parseLine('@MAIN:FOO=On')), undefined);
  applyLine(state, parseLine('@MAIN:INP=NotAnInput'));
  assert.equal(state.zones.MAIN.input, undefined);
  applyLine(state, parseLine('@MAIN:ZONENAME=‮Living\u0007'));
  assert.equal(state.zones.MAIN.name, 'Living');
  assert.equal(applyLine(state, parseLine('@NETRADIO:AVAIL=Ready')), 'SYS');
  assert.ok(state.inputSubunits.has('NETRADIO'));
  assert.equal(Object.getPrototypeOf(state.zones), null);
});
