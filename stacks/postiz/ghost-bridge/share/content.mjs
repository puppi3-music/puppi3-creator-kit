// share/content.mjs: what a post says: reading its HTML (text, video, audio card, gallery images, links, the featured
// link, the #clip tag), and each channel's caption made from it.

import { FEATURED_DOMAINS, SERVICE_NAMES, FEATURED_LINE, FEATURED_BIO_LINE, CLIP_TAG, log, LIMITS, NO_LINK_IDS, INCLUDE_TITLE, TAG_LINKS,
  CAMPAIGN_TAG } from '../config.mjs';
import { esc } from '../pages/preview-render.mjs';

// ---------- Ghost content helpers ----------
// Reading a Ghost post's HTML: its text (bodyText, links marked for the captions below), video, audio
// card, gallery images, links (and which is the featured link), and the #clip tag.
// First Ghost-hosted .mp4 from a video card in the post HTML
export function findVideo(html, postUrl) {
  if (!html) return null;
  const re = /<video\b[^>]*?\ssrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), postUrl).toString();
      if (/\.mp4(\?|$)/i.test(u)) return u;
      log(`  note: found a video that isn't .mp4 (${u.split('/').pop()}) - skipping it`);
    } catch { /* bad URL, keep looking */ }
  }
  return null;
}

// A link's service name: SERVICE_NAMES for its host or a parent domain, else the host (artist.bandcamp.com -> Bandcamp)
function serviceName(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (SERVICE_NAMES[h]) return SERVICE_NAMES[h];
  return host;
}
// A shareable address: tracking junk dropped from share links, no #fragment
export function cleanLink(u) {
  for (const k of [...u.searchParams.keys()]) {
    if (k === 'si' || k === 'feature' || k === 'pp' || k.startsWith('utm_') || k === 'ref') u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString().replace(/\?$/, '');
}
// Every web link in the post that isn't to the site itself, in order, once each: <a href> (text links,
// bookmark cards, captions) and YouTube embeds (as their watch address). { url, name, rank }: rank = place
// of its service in FEATURED_DOMAINS (-1: not a featured link). Player (w.) and API addresses don't count.
export function postLinks(html, postUrl) {
  if (!html) return [];
  let site = '';
  try { site = new URL(postUrl).host; } catch { /* no post url */ }
  const found = [];
  const re = /<a\b[^>]*?\shref="([^"]+)"|<iframe\b[^>]*?\ssrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let u;
    try { u = new URL((m[1] || m[2]).replace(/&amp;/g, '&'), postUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.host === site) continue;
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (m[2]) {
      const id = /^(youtube\.com|youtube-nocookie\.com)$/.test(host) && /^\/embed\/([\w-]{6,})/.exec(u.pathname)?.[1];
      if (!id) continue;
      const t = u.searchParams.get('start');
      u = new URL(`https://www.youtube.com/watch?v=${id}${t ? `&t=${t}` : ''}`);
    } else if (host.startsWith('w.') || host.startsWith('api.')) continue;
    const url = cleanLink(u);
    if (found.some((f) => f.url === url)) continue;
    const name = serviceName(u);
    const domain = FEATURED_DOMAINS.find((d) => host === d || host.endsWith('.' + d));
    // the rank of a service is its first domain's (soundcloud.com and on.soundcloud.com rank the same)
    const rank = domain ? FEATURED_DOMAINS.findIndex((d) => (SERVICE_NAMES[d] || d) === (SERVICE_NAMES[domain] || domain)) : -1;
    found.push({ url, name, rank });
  }
  return found;
}
// The featured link: the best-ranked service's first link (see FEATURED_DOMAINS)
export function findListenLink(links) {
  const best = links.filter((l) => l.rank >= 0).sort((a, b) => a.rank - b.rank)[0];
  return best ? { url: best.url, name: best.name } : null;
}
// A featured link picked on the Social preview: 'none', or an address (any web link)
export function chosenListen(choice) {
  if (choice === 'none') return null;
  try { const u = new URL(choice); return { url: cleanLink(u), name: serviceName(u) }; } catch { return null; }
}

// Images of the post's gallery cards, in order
export function findGalleryImages(html, postUrl) {
  const out = [];
  for (const g of (html || '').matchAll(/<figure\b[^>]*\bkg-gallery-card\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    for (const m of g[1].matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)) {
      try { out.push(new URL(m[1].replace(/&amp;/g, '&'), postUrl).toString()); } catch { /* bad URL, skip it */ }
    }
  }
  return out;
}

// First Ghost-hosted audio file from an audio card
export function findAudio(html, postUrl) {
  if (!html) return null;
  const m = /<audio\b[^>]*?\ssrc="([^"]+)"/i.exec(html);
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), postUrl).toString(); } catch { return null; }
}

// Audio card artwork (used if the post has no feature image)
export function findAudioThumb(html, postUrl) {
  const m = /<img\b[^>]*?\ssrc="([^"]+)"[^>]*class="kg-audio-thumbnail"/i.exec(html || '')
    || /<img\b[^>]*class="kg-audio-thumbnail"[^>]*?\ssrc="([^"]+)"/i.exec(html || '');
  if (!m || !m[1]) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), postUrl).toString(); } catch { return null; }
}

// "12:30", "1:02:30", "750", "12m30s" -> seconds
function parseTime(t) {
  t = String(t).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  const parts = t.split(':').map(Number);
  if (parts.length >= 2 && parts.length <= 3 && parts.every((n) => Number.isFinite(n))) {
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  return null;
}

// Internal tag "#clip 12:30" or "#clip 12:30-13:15" -> { start, length }
export function clipFromTags(tagNames) {
  for (const name of tagNames) {
    if (!name.startsWith(CLIP_TAG)) continue;
    const rest = name.slice(CLIP_TAG.length).replace(/^[\s:=-]+/, '');
    const [a, b] = rest.split(/\s*(?:-|to)\s*/);
    const start = parseTime(a);
    if (start === null) continue;
    const end = b ? parseTime(b) : null;
    const length = end && end > start ? Math.min(90, end - start) : null;
    return { start, length };
  }
  return null;
}

// The post's own text: top-level paragraphs, headings, lists and quotes. Skips cards
// (figures, kg-card blocks, embeds, audio/video) so captions and players don't leak in.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function bodyText(html) {
  if (!html) return '';
  const VOID = new Set(['br', 'img', 'hr', 'input', 'source', 'meta', 'link', 'wbr', 'track', 'col', 'area', 'embed', 'param']);
  const SKIP = new Set(['figure', 'figcaption', 'iframe', 'script', 'style', 'audio', 'video', 'button', 'svg', 'noscript', 'template', 'form', 'table', 'pre']);
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);
  const out = []; // { text, li }
  const stack = [];
  const lists = []; // open <ol>/<ul>: { n } for numbered ones, null for bullets
  let skip = 0;
  let quotes = 0; // open <blockquote>s
  let cur = null;
  let curIsLi = false;
  let curQuote = false;
  const flush = () => {
    if (cur !== null) {
      let t = cur.replace(/[ \t\f\r]+/g, ' ').replace(/ *\n */g, '\n').trim();
      if (t && !/^(•|\d+\.)$/.test(t)) {
        if (curQuote && !/^["“❝]/.test(t)) t = `“${t}”`;
        out.push({ text: t, li: curIsLi });
      }
      cur = null;
    }
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[4] !== undefined) {
      if (!skip && cur !== null) cur += decodeEntities(m[4]).replace(/\n/g, ' ');
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (!closing) {
      if (tag === 'br') { if (!skip && cur !== null) cur += '\n'; continue; }
      if (VOID.has(tag) || attrs.trim().endsWith('/')) continue;
      const isCard = SKIP.has(tag) || (tag === 'div' && /\bkg-card\b/.test(attrs));
      const el = { tag, skipping: isCard };
      stack.push(el);
      if (isCard) { skip++; continue; }
      if (skip) continue;
      if (tag === 'ol') lists.push({ n: Number(/\bstart\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] || 1) });
      else if (tag === 'ul') lists.push(null);
      else if (tag === 'blockquote') quotes++;
      if (BLOCK.has(tag)) {
        flush();
        const list = lists[lists.length - 1];
        cur = tag !== 'li' ? '' : list ? `${list.n++}. ` : '• ';
        curIsLi = tag === 'li';
        curQuote = quotes > 0;
      } else if (tag === 'a' && cur !== null) {
        // a link: marked so each channel can show its address or not (withLinks / withoutLinks)
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        el.link = decodeEntities(href?.[1] ?? href?.[2] ?? '');
        cur += LINK_START;
      }
    } else {
      // pop to the matching open tag (tolerates sloppy nesting)
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i < 0) continue;
      while (stack.length > i) {
        const el = stack.pop();
        if (el.skipping) { skip--; continue; }
        if (skip) continue;
        if (el.link !== undefined && cur !== null) cur += LINK_MID + el.link + LINK_END;
        if (el.tag === 'ol' || el.tag === 'ul') lists.pop();
        else if (el.tag === 'blockquote') quotes--;
        if (BLOCK.has(el.tag)) flush();
      }
    }
  }
  flush();
  // list items stay on consecutive lines; everything else is separated by a blank line
  return out.map((b, i) => (i === 0 ? '' : b.li && out[i - 1].li ? '\n' : '\n\n') + b.text).join('');
}

// Links in the post text, as bodyText marks them: LINK_START text LINK_MID address LINK_END
// (private-use characters, which never appear in a post).
const LINK_START = '\uE000', LINK_MID = '\uE001', LINK_END = '\uE002';
export const LINK_RE = /\uE000([^\uE000-\uE002]*)\uE001([^\uE000-\uE002]*)\uE002/g;

// ---------- captions ----------
// Each channel's caption: its text fitted to the platform's limit (hashtags dropped first), link
// addresses where links can be tapped, the featured link's line, and the site's links tagged with the network (short links).
const hasLinks = (text) => /[\uE000-\uE002]/.test(text || '');
// The link text only (Instagram and TikTok, where links can't be tapped, or when addresses don't fit)
const withoutLinks = (text) => (text || '').replace(LINK_RE, '$1').replace(/[\uE000-\uE002]/g, '');
// "text (address)" for each web link, tagged like the post link when it's to the site. A link whose text
// already is its address, or that is the featured link (it gets its own line), stays as its text.
function withLinks(text, { url, listen, identifier, campaign }) {
  const bare = (u) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  let site = '';
  try { site = new URL(url).host; } catch { /* no post url: nothing is the site */ }
  return (text || '').replace(LINK_RE, (_, label, href) => {
    let u;
    try { u = new URL(href, url); } catch { return label; }
    if (!/^https?:$/.test(u.protocol) || (!href.trim() || href.startsWith('#'))) return label;
    const addr = u.host === site ? tagLink(u.toString(), identifier, campaign) : u.toString();
    if (!label.trim()) return addr;
    // (the featured link is kept cleaned: compared with this one cleaned too, ?si= and all dropped)
    if (bare(label) === bare(u.toString()) || (listen && bare(listen.url) === bare(cleanLink(new URL(u))))) return label;
    return `${label} (${addr})`;
  }).replace(/[\uE000-\uE002]/g, '');
}
// The text each channel starts from: with link addresses where links can be tapped
export const channelText = (text, identifier, data) =>
  (NO_LINK_IDS.includes(identifier) ? withoutLinks(text) : withLinks(text, { ...data, identifier }));

// Split trailing hashtag-only paragraphs off the text so they can be kept last (and trimmed first).
const HASHTAG_LINE = /^(?:#[\p{L}\p{N}_]+[\s,]*)+$/u;
export function splitHashtags(text) {
  const paras = text.split(/\n{2,}/);
  const tags = [];
  while (paras.length && HASHTAG_LINE.test(paras[paras.length - 1].trim())) {
    tags.unshift(...paras.pop().trim().split(/[\s,]+/).filter(Boolean));
  }
  return { main: paras.join('\n\n').trim(), hashtags: tags };
}

function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return '';
  let cut = chars.slice(0, max - 1).join('');
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,.;:!?-]+$/, '') + '…';
}

// Postiz content is HTML: each <p> becomes a line; empty <p></p> = blank line.
const toHtml = (lines) => lines.map((l) => `<p>${esc(l)}</p>`).join('');

// The post's link, tagged with the network it's posted on (see TAG_LINKS), plus utm_campaign when the post
// has a campaign (#campaign-<name>: always the long form, the short links can't carry one). A link that
// already has a utm_source keeps it; anything that isn't a web address is left as it is.
const SHORT_LINK_PREFIX = { bluesky: 'b', threads: 't', instagram: 'i', tiktok: 'k' }; // = redirects.yaml
export function tagLink(url, identifier, campaign = '') {
  if (!url || (!TAG_LINKS && !campaign)) return url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.searchParams.has('utm_source')) return url;
    const network = String(identifier).replace(/-standalone$|-business$/, '');
    const prefix = SHORT_LINK_PREFIX[network];
    if (prefix && !u.hash && !campaign) {
      u.pathname = `/${prefix}${u.pathname.replace(/\/+$/, '')}`;
      return u.toString();
    }
    u.searchParams.set('utm_source', network);
    u.searchParams.set('utm_medium', 'social');
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch { return url; }
}
// The post's campaign from its first #campaign-<name> tag ('' = none); Ghost keeps a tag's case, so lowercased
export function campaignOf(tags) {
  const tag = tags.find((t) => t.startsWith(CAMPAIGN_TAG) && t.length > CAMPAIGN_TAG.length);
  return tag ? tag.slice(CAMPAIGN_TAG.length).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') : '';
}
// The link for an Instagram link-sticker Story: the listen link if there is one, else the post, tagged
export const stickerLink = (listen, url, campaign) => listen?.url || tagLink(url, 'instagram', campaign);

export function buildContent(identifier, data) {
  return toHtml(buildLines(identifier, data));
}

// Link addresses are added only when the whole caption (every hashtag included) still fits; otherwise
// the links stay as their text, rather than losing hashtags or cutting a link in half.
export function buildLines(identifier, data) {
  if (!hasLinks(data.text)) return fitLines(identifier, data);
  if (!NO_LINK_IDS.includes(identifier)) {
    const full = fitLines(identifier, { ...data, text: channelText(data.text, identifier, data) }, { whole: true });
    if (full) return full;
  }
  return fitLines(identifier, { ...data, text: withoutLinks(data.text) });
}

// FEATURED_LINE / FEATURED_BIO_LINE for a featured link: [name] = its service, [url] = the link
export const featuredLine = (line, { name, url }) => line.replace(/\[name\]/g, name).replace(/\[url\]/g, url);

// The caption's lines, fitted to the platform. With whole, null when it doesn't fit without trimming.
function fitLines(identifier, { title, text, url, listen, campaign, custom = false }, { whole = false } = {}) {
  const limit = LIMITS[identifier] ?? 490;
  const noLinks = NO_LINK_IDS.includes(identifier);
  const len = (s) => Array.from(s).length;
  let links;
  if (noLinks) {
    // links aren't clickable here - one line pointing to the bio
    links = [listen ? featuredLine(FEATURED_BIO_LINE, listen) : 'Full post: link in bio 🔗'];
  } else {
    // a link that's already in your text isn't added again
    const has = (u) => (text || '').includes(u);
    links = [...(listen && !has(listen.url) ? [featuredLine(FEATURED_LINE, listen)] : []), ...(has(url) ? [] : [tagLink(url, identifier, campaign)])];
  }
  const { main, hashtags } = splitHashtags(text || '');
  const head = INCLUDE_TITLE && title && !custom ? title : '';

  // Layout: [title] / your text / links / hashtags - blank lines between the blocks
  const assemble = (mainText, tagList) => {
    const blocks = [];
    if (head) blocks.push(head);
    if (mainText) blocks.push(mainText);
    if (links.length) blocks.push(links.join('\n'));
    if (tagList.length) blocks.push(tagList.join(' '));
    return blocks.join('\n\n');
  };

  // Fit the platform: drop hashtags from the end first, then shorten your text as a last resort
  let tagList = [...hashtags];
  let body = main;
  if (whole && len(assemble(body, tagList)) > limit) return null;
  while (len(assemble(body, tagList)) > limit && tagList.length) tagList.pop();
  if (len(assemble(body, tagList)) > limit) {
    const room = limit - len(assemble('', tagList)) - 2;
    body = room > 20 ? truncate(body, room) : '';
  }
  return assemble(body, tagList).split('\n');
}
