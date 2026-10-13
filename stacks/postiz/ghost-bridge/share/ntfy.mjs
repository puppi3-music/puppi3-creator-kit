// share/ntfy.mjs: phone notifications through ntfy: the "post it in the app" ones for Instagram/TikTok, the #bigdrop
// link-Story reminder, and an older post taking off (stats/history.mjs finds those).

import { env, NTFY_URL, NTFY_TOPIC, NTFY_TOKEN, NTFY_USER, NTFY_PASS, DRY_RUN, DRY_RUN_NTFY, NTFY_TITLE_PREFIX,
  DRAFT_TAG, POSTIZ_PUBLIC_URL, SITE_TIMEZONE, previewStore, log, isDry, GRAFANA_URL, ID_PREFIX } from '../config.mjs';
import { photoPage } from '../pages/preview-routes.mjs';
import { stickerLink } from './content.mjs';
import { setTakeOffNotice, takeOffWords, postRef } from '../stats/history.mjs';

// ---------- ntfy ----------
// ntfy keeps a message's first 4096 bytes (it cuts the rest, or without an attachment makes the whole text a
// file), so a longer one is cut here, where it can say so: more is added after the cut
const NTFY_MESSAGE_MAX = 4000;
// A pause after a Story notification, so it reaches the phone before the ones after it
// (sent in order, but not always delivered in order). Seconds, 0 = none.
export const STORY_GAP_MS = Math.max(0, Number(env.NTFY_STORY_GAP ?? 2) || 0) * 1000;
export function fitMessage(text, more = '') {
  if (Buffer.byteLength(text) <= NTFY_MESSAGE_MAX) return text;
  const room = NTFY_MESSAGE_MAX - Buffer.byteLength(`…${more}`);
  let out = '';
  let size = 0;
  for (const ch of text) {
    size += Buffer.byteLength(ch);
    if (size > room) break;
    out += ch;
  }
  return `${out.trimEnd()}…${more}`;
}

export async function notify(msg) {
  if (msg.message) msg = { ...msg, message: fitMessage(msg.message) };
  previewStore.getStore()?.notes.push(msg);
  if (!NTFY_URL) return false;
  const sendAnyway = DRY_RUN && DRY_RUN_NTFY && !previewStore.getStore()?.draft;
  if (isDry()) {
    log(`  [dry run] ntfy: ${JSON.stringify(msg)}`);
    if (!sendAnyway) return false;
  }
  if (NTFY_TITLE_PREFIX && msg.title) msg = { ...msg, title: NTFY_TITLE_PREFIX + msg.title };
  const headers = { 'Content-Type': 'application/json' };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  else if (NTFY_USER) headers.Authorization = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString('base64');
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic: NTFY_TOPIC, ...msg }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    log('  sent ntfy notification');
    return true;
  } catch (e) {
    log(`  WARNING: ntfy notification failed: ${e.cause?.code || e.message}`);
    return false;
  }
}

// The link-sticker Story you add by hand (the API can't do stickers): its own notification, so the feed post's
// notification keeps its buttons and attachment. Attached: the Story's photo (the first, uncropped) or video.
export async function notifyBigDrop({ title, url, listen, campaign, attachment, isClip, kind }) {
  const stickerUrl = stickerLink(listen, url, campaign);
  const lines = [
    `Add a Story with a link sticker for "${title}":`,
    !attachment ? '1. Pick an image or video for it yourself.'
      : isClip ? '1. Save the attached video (your artwork + the audio from the post): tap ⋯ → Save file.'
      : kind === 'video' ? '1. Save the attached video: tap ⋯ → Save file.'
      : '1. Save the attached photo: tap ⋯ → Save file. It isn\'t cropped, so it fills the Story.',
    '2. In Instagram: + → Story, pick it, and add a Link sticker with the link (tap "Copy sticker link").',
    '3. Post the Story.',
    '',
    `Sticker link:\n${stickerUrl}`,
  ];
  if (listen) lines.push('', `Post:\n${url}`);
  return notify({
    title: `🎧 Big drop: add the link Story for "${title}"`,
    message: lines.join('\n'),
    tags: ['loudspeaker'],
    priority: 4,
    // no click target: tapping opens the message in ntfy, where the attachment and buttons are
    actions: [ // ntfy allows max 3 buttons
      { action: 'copy', label: 'Copy sticker link', value: stickerUrl, clear: false },
      { action: 'view', label: 'Open Instagram', url: 'https://www.instagram.com/', clear: false },
      listen ? { action: 'view', label: `Open ${listen.name}`, url: listen.url } : { action: 'view', label: 'Open post', url },
    ],
    ...(attachment ? { attach: attachment, ...(isClip || kind === 'video' ? { filename: isClip ? 'story-clip.mp4' : 'story.mp4' } : {}) } : {}),
  });
}

// "Finish it yourself" notification - one per platform (Instagram / TikTok)
export async function notifyManual({ platform, title, url, listen, campaign, bigDrop, story, caption, attachment, kind, audiogram, drafted, count = 1, photos = [] }) {
  const isIG = platform === 'Instagram';
  const what = isIG
    ? (story ? 'Story' : kind === 'video' ? 'Reel' : count > 1 ? `carousel (${count} photos)` : 'feed post')
    : (kind === 'video' ? 'video' : 'photo post');
  const media = audiogram ? 'video (made from your artwork + the audio in the post)' : kind === 'video' ? 'video' : 'image';
  // several photos: one page with all of them (falls back to a notification per photo if it can't be saved)
  let page = null;
  if (photos.length > 1) {
    try { page = await photoPage({ platform, title, site: new URL(url).origin, photos }); } catch (e) {
      log(`  WARNING: couldn't save the ${platform} photo page (${e.message}), so each photo comes as its own notification`);
    }
  }
  // a big drop's link Story is in here only when the Instagram post is that Story (#story); else it has its own
  const linkStory = isIG && bigDrop && story;
  const lines = [
    `Post it as a ${what} in the ${platform} app:`,
    !attachment ? '1. No image or video found - pick one yourself.'
      : page ? `1. Tap "All ${photos.length} photos", then "Share all" and pick ${platform}${isIG ? ' (Feed)' : ''}: they go in order${isIG ? ', cropped for Instagram' : ''}. Or save them there. (The first is attached here too.)`
      : count > 1 && photos.length > 1 ? `1. Save the ${count} photos: the first is attached here, and photos 2-${count} follow as their own notifications (tap ⋯ → Save file on each).`
      : count > 1 ? `1. Get the ${count} photos: the first is attached here (tap ⋯ → Save file); the rest are in the post${drafted ? ' and the Postiz draft' : ''}.`
      : `1. Save the attached ${media}: tap ⋯ → Save file and it lands in your Download album.`,
    kind === 'video'
      ? `2. Add your @tags${isIG && story ? ' (mention stickers work here)' : ''} - it already has sound.`
      : `2. Add your @tags and music${isIG && story ? ' (stickers work here)' : ''}.`,
    story && isIG ? '3. Post the Story.' : '3. Paste the caption (tap "Copy caption") and post.',
  ];
  if (drafted) lines.push('', `${isIG ? 'An' : 'A'} ${platform} draft is in Postiz too${DRAFT_TAG ? ` (tagged "${DRAFT_TAG}")` : ''} - keep it as your record, or post it from Postiz if it needs nothing.`);
  if (linkStory) lines.push('', `🎧 Big drop: add a link sticker to it → ${stickerLink(listen, url, campaign)}`);
  if (caption) lines.push('', 'Caption:', caption);

  const actions = [];
  if (caption) actions.push({ action: 'copy', label: 'Copy caption', value: caption, clear: false });
  // with the photo page, its button takes the place of "Open Postiz"
  if (page) actions.push({ action: 'view', label: `All ${photos.length} photos`, url: page, clear: false });
  actions.push(isIG
    ? { action: 'view', label: 'Open Instagram', url: 'https://www.instagram.com/', clear: false }
    : { action: 'view', label: 'Open TikTok', url: 'https://www.tiktok.com/', clear: false });
  if (linkStory) actions.push({ action: 'copy', label: 'Copy sticker link', value: stickerLink(listen, url, campaign), clear: false });
  else if (POSTIZ_PUBLIC_URL && !page) actions.push({ action: 'view', label: 'Open Postiz', url: `${POSTIZ_PUBLIC_URL}/launches`, clear: false });

  const sent = await notify({
    title: `${isIG ? '📸' : '🎵'} ${platform}: post "${title}"${linkStory ? ' + link sticker' : ''}`,
    // the caption comes last, so a long one is what gets cut
    message: fitMessage(lines.join('\n'), caption ? '\n(Cut short here: "Copy caption" has all of it.)' : ''),
    tags: [isIG ? 'camera' : 'musical_note'],
    priority: 4,
    // no click target: tapping opens the message in ntfy, where the attachment and buttons are
    actions: actions.slice(0, 3),
    ...(attachment ? { attach: attachment, ...(kind === 'video' ? { filename: `${platform.toLowerCase()}.mp4` } : {}) } : {}),
  });
  // Without the page: an ntfy message carries one attachment, so each further photo comes as its own quiet one, in order
  for (let i = 1; !page && i < photos.length; i++) {
    await notify({
      title: `${isIG ? '📸' : '🎵'} ${platform}: photo ${i + 1} of ${photos.length}, "${title}"`,
      message: 'Tap ⋯ → Save file.',
      tags: [isIG ? 'camera' : 'musical_note'],
      priority: 2,
      attach: photos[i],
    });
  }
  return sent;
}

// An older post taking off (stats/history.mjs' take-off watch): one ntfy notification when it starts, with the Post dashboard
// (GRAFANA_URL, none without one; dashboard <ID_PREFIX>-post; staging's DRY_RUN bridge opens the staging copy)
// and the post itself. TAKEOFF_NTFY=false turns it off.
export function startTakeOffNotices() {
  if ((env.TAKEOFF_NTFY || 'true') !== 'true') return;
  setTakeOffNotice(async ({ network, post, key, was, wasAt, now, usual }) => {
    const w = takeOffWords(network, key);
    const fmt = (x) => Math.round(x).toLocaleString('en-US');
    const hours = Math.max(1, Math.round((Date.now() - wasAt) / 3_600_000));
    const name = String(post.title || post.caption || post.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const when = post.time ? new Date(post.time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: SITE_TIMEZONE }) : '';
    const actions = [];
    if (w.postDashboard && GRAFANA_URL) {
      const q = new URLSearchParams({ 'var-network': network, 'var-post': post.ref || postRef(post.id), from: String(post.time || 'now-90d'), to: 'now' });
      actions.push({ action: 'view', label: 'Post dashboard', url: `${GRAFANA_URL}/d/${ID_PREFIX}-post${DRY_RUN ? '-staging' : ''}?${q}` });
    }
    if (post.permalink) actions.push({ action: 'view', label: `Open on ${w.label}`, url: post.permalink });
    log(`take-off: ${w.label} ${w.noun} ${post.ref || post.id}: ${w.metric} ${fmt(was)} -> ${fmt(now)} in ${hours} h`);
    await notify({ title: `📈 Your ${w.label} ${w.noun} is taking off`, tags: ['chart_with_upwards_trend'],
      message: `${name ? `"${name}"` : `Your ${w.noun}`}${when ? ` (from ${when})` : ''}: +${fmt(now - was)} ${w.metric} in the last ${hours} hours`
        + `${usual != null ? ` (it usually gets about ${fmt(usual)} a day)` : ''}, now ${fmt(now)}.`
        + ' The bridge is keeping every check of it for the next 3 days.',
      ...(actions.length ? { click: actions[0].url, actions } : {}) });
  });
}
