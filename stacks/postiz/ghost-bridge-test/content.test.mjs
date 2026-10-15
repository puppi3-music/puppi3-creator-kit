// share/content.mjs: reading a post (its text, links, the featured link, #clip) and each network's caption.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyText, LINK_RE, postLinks, findListenLink, chosenListen, clipFromTags, splitHashtags, buildLines,
  tagLink, campaignOf, stickerLink, findGalleryImages, findVideo } from '../ghost-bridge/share/content.mjs';
import { LIMITS } from '../ghost-bridge/config.mjs';

const POST = 'https://example.com/my-post/';
const plain = (t) => t.replace(LINK_RE, '$1');
const chars = (s) => Array.from(s).length;

test('bodyText: paragraphs, lists and quotes; cards left out', () => {
  const html = '<p>Hello <strong>world</strong> &amp; friends</p>'
    + '<figure class="kg-card kg-image-card"><img src="/x.jpg"><figcaption>a caption</figcaption></figure>'
    + '<div class="kg-card kg-button-card"><a href="/x">Button</a></div>'
    + '<ul><li>One</li><li>Two</li></ul><ol start="3"><li>Three</li><li>Four</li></ol>'
    + '<blockquote><p>Quoted</p></blockquote><p>Line<br>break</p><!-- a comment -->';
  assert.equal(bodyText(html), 'Hello world & friends\n\n• One\n• Two\n3. Three\n4. Four\n\n“Quoted”\n\nLine\nbreak');
  assert.equal(bodyText(''), '');
  assert.equal(bodyText('<p>&#x1F436; &#39;hi&#39; &nbsp;</p>'), "🐶 'hi'");
});

test('bodyText marks links, so each network can show the address or not', () => {
  const t = bodyText('<p>Read <a href="https://example.com/other/">this</a> now</p>');
  assert.equal(plain(t), 'Read this now');
  assert.deepEqual([...t.matchAll(LINK_RE)].map((m) => [m[1], m[2]]), [['this', 'https://example.com/other/']]);
});

test('tagLink: the site\'s short links per network, and the long form where they can\'t be used', () => {
  assert.equal(tagLink(POST, 'bluesky'), 'https://example.com/b/my-post');
  assert.equal(tagLink(POST, 'threads'), 'https://example.com/t/my-post');
  assert.equal(tagLink(POST, 'instagram-standalone'), 'https://example.com/i/my-post');
  assert.equal(tagLink(POST, 'tiktok-business'), 'https://example.com/k/my-post');
  assert.equal(tagLink('https://example.com/', 'bluesky'), 'https://example.com/b');
  // a network with no short link, an #anchor, a campaign: the long form
  assert.equal(tagLink(POST, 'mastodon'), `${POST}?utm_source=mastodon&utm_medium=social`);
  assert.equal(tagLink(`${POST}#listen`, 'bluesky'), `${POST}?utm_source=bluesky&utm_medium=social#listen`);
  assert.equal(tagLink(POST, 'bluesky', 'summer'), `${POST}?utm_source=bluesky&utm_medium=social&utm_campaign=summer`);
  // already tagged, or not a web address: left as it is
  assert.equal(tagLink(`${POST}?utm_source=x`, 'bluesky'), `${POST}?utm_source=x`);
  assert.equal(tagLink('mailto:me@example.com', 'bluesky'), 'mailto:me@example.com');
  assert.equal(tagLink('', 'bluesky'), '');
});

test('tagLink\'s short links are ones the kit\'s redirects.yaml sends on, tagged with the same network', () => {
  // the rules: "  ^\/b\/([\w-].*?)\/?$: /$1/?utm_source=bluesky&utm_medium=social"
  const yaml = readFileSync(new URL('../../../kit/redirects.yaml', import.meta.url), 'utf8');
  const rules = [...yaml.matchAll(/^ {2}(\^\S+): (\S+)$/gm)].map((m) => [new RegExp(m[1]), m[2]]);
  assert.ok(rules.length > 10, 'the rules in redirects.yaml');
  for (const [network, pathname] of [['bluesky', '/my-post/'], ['threads', '/my-post/'], ['instagram', '/a/b/'],
    ['tiktok', '/my-post/'], ['bluesky', '/']]) {
    const short = new URL(tagLink(`https://example.com${pathname}`, network));
    const rule = rules.find(([re]) => re.test(short.pathname));
    assert.ok(rule, `no redirect for ${short.pathname}`);
    const target = short.pathname.replace(rule[0], rule[1]);
    assert.equal(target, `${pathname}?utm_source=${network}&utm_medium=social`);
  }
});

test('campaignOf: the first #campaign- tag, as a name links can carry', () => {
  assert.equal(campaignOf(['news', '#campaign-summer launch!', '#campaign-other']), 'summer-launch');
  assert.equal(campaignOf(['#campaign-']), '');
  assert.equal(campaignOf([]), '');
});

test('postLinks: links off the site, cleaned, once each; YouTube embeds as watch links', () => {
  const html = '<p><a href="https://www.youtube.com/watch?v=abc123&amp;si=track">a</a>'
    + '<a href="https://example.com/other/">the site</a>'
    + '<a href="https://artist.bandcamp.com/track/x?utm_source=foo#top">b</a>'
    + '<a href="https://www.youtube.com/watch?v=abc123">again</a>'
    + '<a href="https://w.soundcloud.com/player/?url=x">player</a>'
    + '<a href="mailto:me@example.org">mail</a></p>'
    + '<iframe src="https://www.youtube.com/embed/abcdef1?start=30"></iframe>';
  const links = postLinks(html, POST);
  assert.deepEqual(links.map((l) => [l.url, l.name]), [
    ['https://www.youtube.com/watch?v=abc123', 'YouTube'],
    ['https://artist.bandcamp.com/track/x', 'Bandcamp'],
    ['https://www.youtube.com/watch?v=abcdef1&t=30', 'YouTube'],
  ]);
  assert.deepEqual(postLinks('', POST), []);
});

test('findListenLink: the best-ranked service wins (FEATURED_DOMAINS), not the first in the post', () => {
  const links = postLinks('<a href="https://artist.bandcamp.com/x">b</a><a href="https://youtu.be/abc">y</a>'
    + '<a href="https://example.org/blog">blog</a>', POST);
  assert.deepEqual(findListenLink(links), { url: 'https://youtu.be/abc', name: 'YouTube' });
  assert.equal(findListenLink(postLinks('<a href="https://example.org/blog">blog</a>', POST)), null);
  assert.deepEqual(chosenListen('https://on.soundcloud.com/x?si=1'), { url: 'https://on.soundcloud.com/x', name: 'SoundCloud' });
  assert.equal(chosenListen('none'), null);
  assert.equal(chosenListen('not an address'), null);
});

test('clipFromTags: #clip with a start, or a start and an end (at most 90 s)', () => {
  assert.deepEqual(clipFromTags(['#clip 12:30']), { start: 750, length: null });
  assert.deepEqual(clipFromTags(['#clip 1:00-1:45']), { start: 60, length: 45 });
  assert.deepEqual(clipFromTags(['#clip 1:02:03']), { start: 3723, length: null });
  assert.deepEqual(clipFromTags(['#clip 12m30s']), { start: 750, length: null });
  assert.deepEqual(clipFromTags(['#clip 0:10 to 5:00']), { start: 10, length: 90 });
  assert.deepEqual(clipFromTags(['#clip 2:00-1:00']), { start: 120, length: null });
  assert.equal(clipFromTags(['#clip soon']), null);
  assert.equal(clipFromTags(['news']), null);
});

test('splitHashtags: hashtag-only paragraphs at the end come off', () => {
  assert.deepEqual(splitHashtags('Hello #inline\n\n#one #two,\n\n#three'),
    { main: 'Hello #inline', hashtags: ['#one', '#two', '#three'] });
  assert.deepEqual(splitHashtags('Just text'), { main: 'Just text', hashtags: [] });
});

test('buildLines: text, the post link tagged for the network, hashtags last', () => {
  const data = { title: 'T', text: 'New mix out\n\n#house #techno', url: POST };
  assert.deepEqual(buildLines('bluesky', data), ['New mix out', '', 'https://example.com/b/my-post', '', '#house #techno']);
  // links can't be tapped on Instagram and TikTok: the bio
  assert.deepEqual(buildLines('instagram-standalone', data), ['New mix out', '', 'Full post: link in bio 🔗', '', '#house #techno']);
  // the post's link already in the text isn't added again
  assert.deepEqual(buildLines('threads', { ...data, text: `Read it: ${POST}` }), [`Read it: ${POST}`]);
});

test('buildLines: the featured link\'s own line', () => {
  const listen = { url: 'https://soundcloud.com/a/b', name: 'SoundCloud' };
  const data = { text: 'New mix', url: POST, listen };
  assert.deepEqual(buildLines('bluesky', data), ['New mix', '', '🔗 SoundCloud: https://soundcloud.com/a/b', 'https://example.com/b/my-post']);
  assert.deepEqual(buildLines('tiktok', data), ['New mix', '', '🔗 Also on SoundCloud + the full post: link in bio']);
  assert.equal(stickerLink(listen, POST), listen.url);
  assert.equal(stickerLink(null, POST, 'summer'), `${POST}?utm_source=instagram&utm_medium=social&utm_campaign=summer`);
});

test('buildLines: link addresses where they can be tapped, the text only where they can\'t', () => {
  const text = bodyText('<p>Read <a href="https://example.com/other/">this</a> and <a href="https://example.org/x">that</a></p>');
  assert.equal(buildLines('bluesky', { text, url: POST })[0],
    'Read this (https://example.com/b/other) and that (https://example.org/x)');
  assert.equal(buildLines('instagram', { text, url: POST })[0], 'Read this and that');
  // the addresses would push it over Bluesky's limit: they're left out rather than hashtags or the text cut
  const long = bodyText(`<p>${'word '.repeat(40)}<a href="https://example.org/${'x'.repeat(80)}">that</a></p><p>#one #two</p>`);
  const lines = buildLines('bluesky', { text: long, url: POST });
  assert.ok(!lines.join('\n').includes('example.org'));
  assert.equal(lines.at(-1), '#one #two');
});

test('buildLines: every network\'s caption fits its limit, hashtags dropped first, then the text cut', () => {
  const tags = Array.from({ length: 40 }, (_, i) => `#tag${i}`).join(' ');
  for (const [network, limit] of Object.entries(LIMITS)) {
    // fits once some hashtags go
    const main = 'x'.repeat(limit - 120);
    const fitted = buildLines(network, { text: `${main}\n\n${tags}`, url: POST }).join('\n');
    assert.ok(chars(fitted) <= limit, `${network}: ${chars(fitted)} > ${limit}`);
    assert.ok(fitted.startsWith(main), `${network}: the text is whole`);
    assert.match(fitted, /#tag0 /, `${network}: the first hashtags are kept`);
    assert.doesNotMatch(fitted, /#tag39/, `${network}: the last hashtags go`);
    // the text alone is too long: cut, with …
    const cut = buildLines(network, { text: `${'word '.repeat(limit)}\n\n${tags}`, url: POST }).join('\n');
    assert.ok(chars(cut) <= limit, `${network}: ${chars(cut)} > ${limit}`);
    assert.match(cut, /…\n/, `${network}: cut with …`);
    assert.doesNotMatch(cut, /#tag/, `${network}: no hashtags left`);
  }
});

test('the post\'s gallery images and video, as full addresses', () => {
  const html = '<figure class="kg-card kg-gallery-card"><div><img src="/content/images/a.jpg"><img src="https://cdn.example.com/b.png?w=1&amp;h=2"></div></figure>'
    + '<figure class="kg-card kg-image-card"><img src="/content/images/not-gallery.jpg"></figure>'
    + '<video src="/content/media/clip.webm"></video><video src="/content/media/clip.mp4"></video>';
  assert.deepEqual(findGalleryImages(html, POST),
    ['https://example.com/content/images/a.jpg', 'https://cdn.example.com/b.png?w=1&h=2']);
  assert.equal(findVideo(html, POST), 'https://example.com/content/media/clip.mp4');
});
