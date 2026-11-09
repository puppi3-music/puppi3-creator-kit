// matchStories: an Instagram Story matched by time to the share it came from, and pageFor's use of the match.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { matchStories } = await import('../ghost-bridge/stats/story-match.mjs');
const { pageFor } = await import('../ghost-bridge/stats/post.mjs');

const T = Date.parse('2026-11-01T20:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const share = (title, at, result = 'manual', extra = {}) => ({ title, url: `https://example.com/${title}/`, at: iso(at),
  results: { instagram: 'ok', 'instagram:story': result }, ...extra });
const story = (minutes, extra = {}) => ({ time: T + minutes * MIN, caption: '', ...extra });

test('a Story by hand gets the caption saved with its share, and the share', () => {
  const s = story(45);
  matchStories([s], { p1: share('tune', T, 'manual', { storyCaption: 'Out now' }) });
  assert.equal(s.caption, 'Out now');
  assert.deepEqual([s.share.postId, s.share.title, s.share.by], ['p1', 'tune', 'hand']);
});

test('no caption: the post\'s title; a share from before posted.json kept it: custom.json\'s', () => {
  const [a, b] = [story(5), story(5)];
  matchStories([a], { p1: share('tune', T, 'ok') });
  assert.deepEqual([a.caption, a.share.by], ['tune', 'postiz']);
  matchStories([b], { p1: share('tune', T) }, { p1: { storyCaption: 'From the preview' } });
  assert.equal(b.caption, 'From the preview');
});

test('a caption Instagram does give stays', () => {
  const s = story(5, { caption: 'from instagram' });
  matchStories([s], { p1: share('tune', T) });
  assert.equal(s.caption, 'from instagram');
  assert.equal(s.share.postId, 'p1');
});

test('the windows: Postiz an hour, by hand six, a little before the share, none without a Story in the share', () => {
  const none = (s, posted) => { matchStories([s], posted); assert.equal(s.share, undefined); };
  none(story(61), { p1: share('tune', T, 'ok') });
  none(story(361), { p1: share('tune', T) });
  none(story(-16), { p1: share('tune', T) });
  none(story(5), { p1: { ...share('tune', T), results: { instagram: 'ok' } } });
  none(story(5), { p1: share('tune', T, 'error') });
  const early = story(-10);
  matchStories([early], { p1: share('tune', T) });
  assert.equal(early.share.postId, 'p1');
});

test('a Story set for later is due at its own time', () => {
  const [s] = [story(300)];
  matchStories([s], { p1: share('tune', T, 'ok', { storyAt: iso(T + 295 * MIN) }) });
  assert.equal(s.share.postId, 'p1');
});

test('a Story goes with the latest share due by then; a share takes one Story; a match stays', () => {
  const posted = { p1: share('one', T), p2: share('two', T + 60 * MIN) };
  const [a, b, c] = [story(30), story(70), story(80)];
  matchStories([c, a, b], posted);
  assert.deepEqual([a.share.postId, b.share.postId, c.share], ['p1', 'p2', undefined]);
  const key = b.share.key;
  matchStories([a, b, c], { p3: share('three', T + 60 * MIN) });
  assert.equal(b.share.key, key);
  assert.equal(c.share.postId, 'p3');
});

test('shared twice with a Story: each share can have its own', () => {
  const entry = { ...share('tune', T + 120 * MIN), earlier: [{ at: iso(T), results: { 'instagram:story': 'manual' } }] };
  const [a, b] = [story(5), story(125)];
  matchStories([a, b], { p1: entry });
  assert.deepEqual([a.share.postId, b.share.postId], ['p1', 'p1']);
  assert.notEqual(a.share.key, b.share.key);
});

test('pageFor: a matched Story leads to its post, as a guess; a link in the post comes first', () => {
  const ghost = [{ slug: 'tune', title: 'Tune', url: 'https://example.com/tune/', published_at: iso(T) }];
  const s = { ...story(5), links: [], share: { title: 'Tune', url: 'https://example.com/tune/' } };
  const pf = pageFor('instagram', s, ghost, true);
  assert.deepEqual([pf.page, pf.pageTitle, pf.pageFrom], ['/tune/', 'Tune', 'share']);
  assert.match(pf.pageNote, /guess/i);
  assert.equal(pageFor('instagram', { ...s, links: ['/tune/'] }, ghost, true).pageFrom, 'link');
});
