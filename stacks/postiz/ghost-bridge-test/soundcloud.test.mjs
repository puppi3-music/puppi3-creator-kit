// stats/soundcloud.mjs: one poll of SoundCloud's numbers (soundcloud.json) with the bridge's own SoundCloud app
// against a fake SoundCloud: its sign-in (reused until it runs out), every page of tracks, playlists, totals per day.
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectors, web, date } from './collectors.mjs';

const c = await collectors({ SOUNDCLOUD_CLIENT_ID: 'sc-id', SOUNDCLOUD_CLIENT_SECRET: 'sc-secret', SOUNDCLOUD_USER: '@djname' });
const { pollSoundCloudStats } = await import('../ghost-bridge/stats/soundcloud.mjs');
async function poll(prev) {
  if (prev) fs.writeFileSync(`${c.dataDir}/soundcloud.json`, JSON.stringify(prev));
  else fs.rmSync(`${c.dataDir}/soundcloud.json`, { force: true });
  await pollSoundCloudStats();
  return c.read('soundcloud');
}

const SIGN_IN = 'https://secure.soundcloud.com/oauth/token';
const API = 'https://api.soundcloud.com';
const USER = 'soundcloud:users:1';
// SoundCloud's own date format
const scDate = (daysAgo) => `${date(daysAgo).replace(/-/g, '/')} 18:30:00 +0000`;
const track = (n, daysAgo, plays) => ({ kind: 'track', urn: `soundcloud:tracks:${n}`, title: `Track ${n}`, created_at: scDate(daysAgo),
  duration: 180_500, playback_count: plays, favoritings_count: 3, reposts_count: 1, comment_count: 0,
  description: n === 1 ? 'Full post: https://www.example.com/track-one/' : '', permalink_url: `https://soundcloud.com/djname/t${n}` });
let tokens = 0;
let expireOnce = false;
function soundcloud() {
  web.on(SIGN_IN, (url, req) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('sc-id:sc-secret').toString('base64')}`);
    tokens++;
    return { access_token: `sc-token-${tokens}`, expires_in: 3600, refresh_token: 'sc-refresh' };
  });
  web.on(API, (url, req) => {
    if (expireOnce) { expireOnce = false; return { status: 401, body: {} }; }
    assert.match(req.headers.authorization, /^OAuth sc-token-\d+$/);
    const p = url.pathname;
    if (p === '/resolve') {
      assert.equal(url.searchParams.get('url'), 'https://soundcloud.com/djname');
      return { kind: 'user', urn: USER, username: 'djname', full_name: 'DJ', avatar_url: 'sc.jpg', permalink_url: 'https://soundcloud.com/djname',
        followers_count: 210, followings_count: 12, track_count: 3, playlist_count: 1 };
    }
    if (p === `/users/${USER}/tracks`) {
      return url.searchParams.get('cursor') === '2'
        ? { collection: [track(3, 200, 5)] }
        : { collection: [track(1, 2, 40), track(2, 20, 60)], next_href: `${API}/users/${USER}/tracks?cursor=2` };
    }
    if (p === `/users/${USER}/playlists`) {
      return [{ urn: 'soundcloud:playlists:9', title: 'Best of', created_at: scDate(30), is_album: true, track_count: 3, likes_count: 4, reposts_count: 0 }];
    }
    return { status: 404, body: { error: 'no such fake' } };
  });
}
beforeEach(() => web.reset());

test('the profile from its name, every page of tracks, playlists, the day\'s totals and gains', async () => {
  soundcloud();
  const out = await poll({ history: { [date(1)]: { followers: 200, plays: 95, likes: 9, reposts: 3, comments: 0 } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { id: USER, name: 'DJ', username: 'djname', picture: 'sc.jpg', url: 'https://soundcloud.com/djname' });
  assert.deepEqual(out.tracks.map((t) => [t.title, t.plays, t.duration, t.date.slice(0, 10)]),
    [['Track 1', 40, 181, date(2).replace(/-/g, '/')], ['Track 2', 60, 181, date(20).replace(/-/g, '/')], ['Track 3', 5, 181, date(200).replace(/-/g, '/')]]);
  assert.equal(out.tracks[0].time, Date.parse(`${date(2)}T18:30:00Z`), 'SoundCloud\'s date read');
  assert.deepEqual(out.tracks[0].links, ['/track-one/']);
  assert.deepEqual([out.totals.followers, out.totals.plays, out.totals.likes], [210, 105, 9]);
  assert.deepEqual(out.playlists.map((p) => [p.title, p.type, p.likes]), [['Best of', 'Album', 4]]);
  const today = out.daily.find((d) => d.date === date(0));
  assert.deepEqual([today.newFollowers, today.newPlays, today.newLikes], [10, 10, 0]);
  assert.deepEqual([out.totals.newFollowers30, out.totals.newPlays30], [10, 10]);
  assert.deepEqual(web.unanswered, []);
});

test('its sign-in is reused until it runs out; a 401 signs in again once', async () => {
  soundcloud();
  const before = tokens;
  await poll();
  assert.equal(tokens, before, 'the last poll\'s token');
  expireOnce = true;
  const out = await poll();
  assert.deepEqual(out.errors, []);
  assert.equal(tokens, before + 1, 'one new sign-in after the 401');
});

test('too many sign-ins, and a name that\'s a track, not a profile', async () => {
  soundcloud();
  expireOnce = true;
  web.on(SIGN_IN, { status: 429, body: { error: 'too_many_requests' } });
  assert.deepEqual((await poll()).errors, ['SoundCloud sign-in: too_many_requests (too many sign-ins: SoundCloud allows 50 per 12 hours per app)']);
  soundcloud();
  web.on(`${API}/resolve`, { kind: 'track', urn: 'soundcloud:tracks:1' });
  assert.deepEqual((await poll()).errors, ['SOUNDCLOUD_USER is a track, not a profile']);
});
