// stats/live.mjs: live shows from TinyIce's status (a show's start, length, listeners and tracks, as polls see it
// over time), the theme's beacons (links followed off the site, LIVE NOW bar plays and hiccups) and puppy pets,
// with the caps that keep anyone calling them from running up the numbers.
import './env.mjs';
import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { collectors, web, NOW, date } from './collectors.mjs';

const c = await collectors({ ID_PREFIX: 'test-radio', LIVE_RELAYS: 'localhost' });
const { countPets, savePets, pets } = await import('../ghost-bridge/stats/live.mjs');
const STATUS = 'http://tinyice:8080/status-json.xsl';
const MIN = 60_000;
let now = NOW;
const at = (ms) => { now = NOW + ms; mock.timers.setTime(now); };
beforeEach(() => web.reset());

// the theme's beacons and the puppies' pets, sent the way Traefik passes them on (X-Real-Ip: the visitor)
const server = http.createServer((req, res) => (req.url.startsWith('/.site/click') ? c.stats.countClick(req, res) : countPets(req, res)));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
after(() => server.close());
async function send(pathAndQuery, visitor = '198.51.100.1') {
  const res = await new Promise((ok, fail) => http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
    path: pathAndQuery, headers: { 'X-Real-Ip': visitor } }, ok).on('error', fail).end());
  res.resume();
  return res.statusCode;
}

const source = (mount, listeners, extra = {}) => ({ mount, listeners, ...extra });
async function status(sources, ms) {
  at(ms);
  web.on(STATUS, sources instanceof Error ? { status: 503, body: {} } : { icestats: { source: sources } });
  await c.stats.live();
  return c.read('live');
}

test('a show: from the mount appearing until it\'s been gone longer than the gap; listeners, peak, tracks, plays', async () => {
  let doc = await status([source('/stream-ogg', 3, { artist: 'Artist', title: 'First' }), source('/stream-mp3', 5)], 0);
  assert.equal(doc.status, 'live');
  assert.equal(doc.listenersNow, 8, 'every mount\'s listeners');
  assert.equal(doc.current.start, NOW);
  assert.equal(await send('/.site/click?kind=play&from=/'), 204);
  await status([source('/stream-ogg', 4, { artist: 'Artist', title: 'Second' }), source('/stream-mp3', 6)], 2 * MIN);
  await status([source('/stream-ogg', 4, { artist: 'Artist', title: 'Second' }), source('/stream-mp3', 6)], 4 * MIN);
  doc = await status([source('/stream-mp3', 0)], 6 * MIN);
  assert.equal(doc.status, 'off');
  assert.ok(doc.current, 'a gap shorter than LIVE_GAP_MINUTES: the show goes on (it may be reconnecting)');
  doc = await status([], 10 * MIN);
  assert.equal(doc.current, null);
  assert.equal(doc.shows.length, 1);
  const [show] = doc.shows;
  // listener-seconds: 10 listeners for each of the two polls after the first, a minute at most each (the poll is 30 s)
  assert.deepEqual([show.minutes, show.peakListeners, show.avgListeners, show.listenerHours, show.plays, show.tracks],
    [4, 10, 5, 0.3, 1, 2]);
  assert.equal(show.setlist, '0:00 Artist – First · 0:02 Artist – Second');
  assert.equal(show.end, NOW + 4 * MIN);
  assert.deepEqual([doc.totals.shows, doc.totals.shows30, doc.totals.peak30], [1, 1, 10]);
  assert.deepEqual(doc.showsPerDay, [{ date: date(0), shows: 1 }]);
});

test('a test connection shorter than LIVE_MIN_MINUTES isn\'t kept; one source sent as an object still counts', async () => {
  await status(source('/stream-ogg', 1), 20 * MIN);
  await status(source('/stream-ogg', 1), 21 * MIN);
  const doc = await status([], 30 * MIN);
  assert.equal(doc.shows.length, 1, 'only the show before');
});

test('TinyIce not answering: status unknown, said in errors', async () => {
  const doc = await status(new Error(), 40 * MIN);
  assert.deepEqual([doc.status, doc.listenersNow, doc.errors], ['unknown', null, ['TinyIce: 503']]);
});

test('relays (LIVE_RELAYS): their listeners count instead of the relays themselves', async () => {
  const relays = await lookup('localhost', { all: true });
  for (const { address, family } of relays) {
    web.on(`http://${family === 6 ? `[${address}]` : address}:8080/status-json.xsl`, { icestats: { source: [source('/stream-ogg', 4)] } });
  }
  // TinyIce sees each relay as a listener, plus 2 listening to it directly
  const doc = await status([source('/stream-ogg', relays.length + 2)], 50 * MIN);
  assert.equal(doc.listenersNow, 2 + 4 * relays.length);
});

test('clicks: links off the site by service, plays, hiccups; the site\'s own links and bad beacons not counted', async () => {
  const before = c.read('clicks').totals;
  assert.equal(await send('/.site/click?kind=out&to=https://soundcloud.com/dj/set?utm=x&from=/new-mix/?ref=1'), 204);
  assert.equal(await send('/.site/click?kind=out&to=https://www.bandcamp.com/album/a/&from=/new-mix/'), 204);
  assert.equal(await send('/.site/click?kind=out&to=https://example.com/elsewhere/&from=/new-mix/'), 204, 'the site\'s own: answered, not counted');
  assert.equal(await send('/.site/click?kind=out&to=javascript:alert(1)&from=/'), 204, 'not a web link: not counted');
  assert.equal(await send('/.site/click?kind=out&to=https://soundcloud.com/x&from=https://evil.test/'), 400, 'from must be a site path');
  assert.equal(await send('/.site/click?kind=nope&from=/'), 400);
  assert.equal(await send('/.site/click?kind=stall&why=buffering&hidden=1&device=mobile&browser=safari&from=/'), 204);
  assert.equal(await send('/.site/click?kind=stall&why=made-up&device=mobile&browser=safari&from=/'), 400);
  c.stats.save();
  const doc = c.read('clicks');
  assert.equal(doc.totals.out.SoundCloud, (before.out.SoundCloud || 0) + 1);
  assert.equal(doc.totals.out.Bandcamp, 1);
  assert.equal(doc.totals.out.Other, undefined);
  assert.equal(doc.totals.hiccups['stall\tbuffering\thidden\tmobile\tsafari'], 1);
  const row = doc.clicks.find((r) => r.service === 'SoundCloud');
  assert.deepEqual([row.from, row.target, row.date], ['/new-mix/', 'soundcloud.com/dj/set', date(0)]);
  const metrics = c.stats.metrics();
  assert.match(metrics, /^test_radio_link_clicks_total\{service="Bandcamp"\} 1$/m);
  assert.match(metrics, /^test_radio_live_stalls_total\{why="buffering",tab="hidden",device="mobile",browser="safari"\} 1$/m);
  assert.match(metrics, /^# TYPE test_radio_live_reconnects_total counter$/m, 'even with none yet');
});

test('clicks: each visitor counts up to 60 per 10 minutes', async () => {
  const before = c.read('clicks').totals.play;
  for (let i = 0; i < 65; i++) await send('/.site/click?kind=play&from=/', '203.0.113.50');
  await send('/.site/click?kind=play&from=/', '203.0.113.51');
  c.stats.save();
  assert.equal(c.read('clicks').totals.play, before + 61);
});

test('pets: counted in batches, at most 200 a batch and 2000 a visitor per 10 minutes', async () => {
  const start = pets.total;
  assert.equal(await send('/.puppy/pets?n=5'), 204);
  assert.equal(await send('/.puppy/pets?n=500'), 204);
  assert.equal(await send('/.puppy/pets?n=0'), 400);
  assert.equal(await send('/.puppy/pets?n=lots'), 400);
  assert.equal(pets.total, start + 205);
  for (let i = 0; i < 20; i++) await send('/.puppy/pets?n=200', '203.0.113.60');
  assert.equal(pets.total, start + 205 + 2000);
  savePets();
  assert.equal(c.read('pets').total, pets.total);
});
