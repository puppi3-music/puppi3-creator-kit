// When the phone hears from the bridge: the weekly summary's time, the seasonal profile pictures' season, and
// ntfy's size limit.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAt, lastDue } from '../ghost-bridge/share/weekly.mjs';
import { seasonOn } from '../ghost-bridge/share/pfp.mjs';
import { fitMessage } from '../ghost-bridge/share/ntfy.mjs';

test('parseAt: WEEKLY_SUMMARY_AT as "<weekday> HH:MM", Monday 09:00 when it isn\'t', () => {
  assert.deepEqual(parseAt('Fri 18:30'), { dow: 5, hour: 18, minute: 30 });
  assert.deepEqual(parseAt(' sunday 7:05 '), { dow: 0, hour: 7, minute: 5 });
  for (const bad of ['', 'Mon', 'Mon 24:00', 'Mon 9:60', 'Someday 09:00', null]) {
    assert.deepEqual(parseAt(bad), { dow: 1, hour: 9, minute: 0 }, String(bad));
  }
});

test('lastDue: the latest send time at or before now, in the site\'s time zone', () => {
  const MON_9 = { dow: 1, hour: 9, minute: 0 };
  // Thursday 15 Oct 2026: Monday the 12th
  assert.deepEqual(lastDue(Date.parse('2026-10-15T12:00:00Z'), MON_9, 'Etc/UTC'),
    { due: '2026-10-12', at: Date.parse('2026-10-12T09:00:00Z') });
  // on the Monday itself: from 09:00, not before
  assert.equal(lastDue(Date.parse('2026-10-12T09:00:00Z'), MON_9, 'Etc/UTC').due, '2026-10-12');
  assert.equal(lastDue(Date.parse('2026-10-12T08:59:00Z'), MON_9, 'Etc/UTC').due, '2026-10-05');
  // New York in October is UTC-4: 09:00 there is 13:00 UTC
  const ny = 'America/New_York';
  assert.deepEqual(lastDue(Date.parse('2026-10-12T13:00:00Z'), MON_9, ny), { due: '2026-10-12', at: Date.parse('2026-10-12T13:00:00Z') });
  assert.equal(lastDue(Date.parse('2026-10-12T12:59:00Z'), MON_9, ny).due, '2026-10-05');
  // late Sunday in New York is already Monday in UTC: still the week before
  assert.equal(lastDue(Date.parse('2026-10-12T03:00:00Z'), MON_9, ny).due, '2026-10-05');
  // in January it's UTC-5
  assert.equal(lastDue(Date.parse('2026-01-12T14:00:00Z'), MON_9, ny).at, Date.parse('2026-01-12T14:00:00Z'));
});

test('seasonOn: matched like the theme\'s puppies.js, the last match wins', () => {
  const seasons = [['winter', 1201, 1231], ['newyear', 1231, 1231], ['newyear', 101, 102], ['pride', 601, 630]];
  assert.equal(seasonOn('2026-12-30', seasons), 'winter');
  assert.equal(seasonOn('2026-12-31', seasons), 'newyear');
  assert.equal(seasonOn('2027-01-02', seasons), 'newyear');
  assert.equal(seasonOn('2027-01-03', seasons), null);
  assert.equal(seasonOn('2026-06-30', seasons), 'pride');
  assert.equal(seasonOn('2026-06-30', []), null);
});

test('fitMessage: ntfy keeps 4096 bytes, so a longer message is cut on a character, saying so', () => {
  assert.equal(fitMessage('short'), 'short');
  const long = 'é'.repeat(3000); // 6000 bytes
  const cut = fitMessage(long, ' (more in Grafana)');
  assert.ok(Buffer.byteLength(cut) <= 4000, `${Buffer.byteLength(cut)} bytes`);
  assert.ok(cut.endsWith('é… (more in Grafana)'));
  assert.ok(!cut.includes('�'), 'no character cut in half');
  // emoji are 4 bytes and two UTF-16 units: never split
  const emoji = fitMessage('🐶'.repeat(1500));
  assert.ok(Buffer.byteLength(emoji) <= 4000);
  assert.match(emoji, /^(🐶)+…$/u);
});
