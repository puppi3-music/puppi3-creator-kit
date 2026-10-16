// share/share.mjs: sharing one published post (handlePost): which channels, what media, each caption, auto-post or a
// draft + ntfy for Instagram/TikTok, and recording it. Previews run the same code with everything dry.
// Also GET /upnext.json (upNextDoc): Ghost's scheduled posts and where each will go, by the same rules.

import { CHANNELS, SKIP_TAG, BIG_DROP_TAG, BIG_DROP_AUTO_STORY, MUSIC_MODE, AUTOPOST_TAG, MANUALPOST_TAG, STORY_TAG,
  MANUAL_DRAFTS, DRAFT_TAG, ONLY_PUBLIC, TEXT_SOURCE, INCLUDE_TITLE, EXCERPT_TAG, CUSTOM_CHANNELS, SHARE_VIDEO, GALLERY,
  MAX_IMAGES, TIKTOK_METHOD, TIKTOK_PRIVACY, NTFY_URL, NOTIFY_ERRORS, AUDIOGRAM, INSTAGRAM_IDS, TIKTOK_IDS,
  IMAGE_LIMITS, previewStore, log, isDry, loadState, recordShared, loadCustom, channelKey, DRAFT_BASE, DRAFT_PREVIEWS,
  GHOST_API_URL } from '../config.mjs';
import { postiz, postizChannels, uploadMedia, ghostToken, ghostSiteOrigin } from '../services.mjs';
import { notify, notifyBigDrop, notifyManual, STORY_GAP_MS } from './ntfy.mjs';
import { bodyText, findVideo, findAudio, findGalleryImages, postLinks, findListenLink, chosenListen, splitHashtags,
  channelText, buildLines, buildContent, campaignOf, stickerLink, tagLink } from './content.mjs';
import { uploadAsJpeg, fitImages, fitContext, makeAudiogram, POSTABLE, IMAGE_RULES, pathOf } from './media.mjs';

function settingsFor(identifier, { story = false } = {}) {
  // Instagram: video -> Reel automatically; story -> Story (image or video)
  if (INSTAGRAM_IDS.includes(identifier)) return { post_type: story ? 'story' : 'post' };
  if (TIKTOK_IDS.includes(identifier)) {
    return {
      privacy_level: TIKTOK_PRIVACY,
      duet: false,
      stitch: false,
      comment: true,
      autoAddMusic: 'no',
      brand_content_toggle: false,
      brand_organic_toggle: false,
      video_made_with_ai: false,
      content_posting_method: TIKTOK_METHOD,
    };
  }
  return {};
}

// Instagram/TikTok: auto-post, or a draft + ntfy for you to finish in the app (IG_TIKTOK_MODE, #autopost/#manualpost)
export function musicRouting(tags, kind, audiogram) {
  const forceAuto = tags.includes(AUTOPOST_TAG);
  const forceManual = tags.includes(MANUALPOST_TAG);
  const hasSound = kind === 'video';
  const auto = forceManual ? false
    : forceAuto ? true
    : MUSIC_MODE === 'auto' ? true
    : MUSIC_MODE === 'manual' ? false
    : hasSound;
  const why = forceManual ? MANUALPOST_TAG : forceAuto ? AUTOPOST_TAG
    : MUSIC_MODE !== 'audio' ? `IG_TIKTOK_MODE=${MUSIC_MODE}`
    : hasSound ? (audiogram ? 'post has an audio card' : 'post has a video') : 'post has no sound';
  return { auto, why };
}

// ---------- main handler ----------
export async function handlePost(post) {
  const id = post.id;
  const title = (post.title || '').trim();
  const url = post.url;
  const excerpt = (post.custom_excerpt || post.excerpt || '').replace(/\s+/g, ' ').trim();
  const tags = (post.tags || []).map((t) => (t.name || '').toLowerCase());
  const useExcerpt = TEXT_SOURCE === 'excerpt' || (tags.includes(EXCERPT_TAG) && excerpt);
  const fullBody = bodyText(post.html);
  const body = useExcerpt ? '' : fullBody;
  // with #useexcerpt, keep the hashtags from the end of your post text
  const bodyTags = splitHashtags(fullBody).hashtags;
  const excerptText = useExcerpt && bodyTags.length && !excerpt.includes('#')
    ? `${excerpt}\n\n${bodyTags.join(' ')}` : excerpt;
  // the words used in captions: your post text (or the Excerpt with #useexcerpt), else the excerpt, else the title
  const text = body || excerptText || (INCLUDE_TITLE ? '' : title);

  log(`Received "${title}" (${id})`);
  log(`  caption text: ${body ? 'post text' : excerpt ? `excerpt${useExcerpt && TEXT_SOURCE !== 'excerpt' ? ` (${EXCERPT_TAG})` : ''}` : 'title'}`);

  const draftPreview = previewStore.getStore()?.draft === true;
  if (post.status && post.status !== 'published' && !draftPreview) return log('  skip: not published');
  if (ONLY_PUBLIC && post.visibility && post.visibility !== 'public')
    return log(`  skip: visibility is ${post.visibility}`);
  if (tags.includes(SKIP_TAG)) return log(`  skip: has tag ${SKIP_TAG}`);
  if (!url || !title) return log('  skip: missing title or url');

  const custom = (await loadCustom())[id] || {};
  const customFor = (idf) => custom[channelKey(idf)] || '';
  const say = (idf) => ({ title, text: customFor(idf) || text, url, listen, campaign, custom: !!customFor(idf) });
  const own = CUSTOM_CHANNELS.filter((c) => custom[c]);
  if (own.length) log(`  modified text for: ${own.join(', ')}`);
  if (custom.frames) log(`  instagram framing set for ${Object.keys(custom.frames).length} photo(s)`);
  const stickerText = custom.sticker || '';
  if (previewStore.getStore()) Object.assign(previewStore.getStore(), { custom });

  const state = await loadState();
  if (state[id] && !draftPreview) return log(`  skip: already shared on ${state[id].at}`);
  if (state[id]) previewStore.getStore().shared = state[id].at;

  log('  looking up Postiz channels...');
  const all = await postizChannels();
  log(`  Postiz channels: ${all.map((i) => `${i.identifier}${i.disabled ? ' (disabled)' : ''}`).join(', ') || 'none'}`);
  const integrations = all.filter((i) => CHANNELS.includes(i.identifier) && !i.disabled);
  if (!integrations.length) return log('  no matching Postiz channels found - check CHANNELS');

  const bigDrop = tags.includes(BIG_DROP_TAG);
  const asStory = tags.includes(STORY_TAG);
  if (bigDrop) log(`  big drop (${BIG_DROP_TAG})`);
  // an Instagram Story you post by hand gets a sticker: #bigdrop's does, unless the Social preview says otherwise
  const storyLink = typeof custom.storyLink === 'boolean' ? custom.storyLink : bigDrop;
  if (typeof custom.storyLink === 'boolean') log(`  sticker ${storyLink ? 'on' : 'off'} (picked on the Social preview)`);
  if (stickerText) log(`  sticker text "${stickerText}"`);
  if (asStory) log(`  ${STORY_TAG}: Instagram gets a Story instead of a feed post`);
  const campaign = campaignOf(tags);
  if (campaign) log(`  campaign: links carry utm_campaign=${campaign}`);
  const links = postLinks(post.html, url);
  const autoListen = findListenLink(links);
  const listen = custom.listen ? chosenListen(custom.listen) : autoListen;
  if (previewStore.getStore()) Object.assign(previewStore.getStore(), { listen: { auto: autoListen, links, chosen: custom.listen || '' } });
  if (custom.listen) log(`  listen link picked on the Social preview: ${listen ? listen.url : 'none'}`);
  else if (listen) log(`  found ${listen.name} link: ${listen.url}`);
  // the sticker's link: the featured link, else the post; or picked on the Social preview: 'none' (a sticker of
  // text only) or any address (tagged when it's on the site, like the post's own)
  const autoSticker = stickerLink(listen, url, campaign);
  const onSite = (link) => { try { return new URL(link).host === new URL(url).host; } catch { return false; } };
  const chosenSticker = custom.stickerLink || '';
  const igSticker = chosenSticker === 'none' ? null : !chosenSticker ? autoSticker
    : onSite(chosenSticker) ? tagLink(chosenSticker, 'instagram', campaign) : chosenSticker;
  if (chosenSticker) log(`  sticker link: ${igSticker || 'none'} (picked on the Social preview)`);
  // on, with something to add: a link, or (no link) its text
  const stickerOn = storyLink && !!(igSticker || stickerText);
  const stickerInfo = { stickerOn, stickerUrl: igSticker, stickerAuto: autoSticker, stickerChosen: chosenSticker, stickerText,
    stickerPicked: storyLink };
  // each channel's starting text for the preview's "Modify text" box (link addresses only where they can be tapped)
  if (previewStore.getStore()) {
    previewStore.getStore().autoText = Object.fromEntries(CUSTOM_CHANNELS.map((key) => [key, channelText(text, key, { url, listen, campaign })]));
  }

  // Pick the media: Ghost video > Ghost audio card (rendered clip) > feature image + gallery images
  let media = null;
  let images = []; // all the images, when the post shares images (media is the first)
  let kind = null;
  let audiogram = false;
  const videoUrl = SHARE_VIDEO ? findVideo(post.html, url) : null;
  if (videoUrl) {
    log(`  found video: ${videoUrl}`);
    try { media = await uploadMedia(videoUrl, 'video'); kind = 'video'; }
    catch (e) { log(`  WARNING: video upload failed: ${e.message}`); }
  }
  if (!media && AUDIOGRAM && findAudio(post.html, url)) {
    try {
      // Instagram Stories take up to 60s of video
      const clip = await makeAudiogram(post, url, tags, { maxLength: asStory ? 60 : 90 });
      if (clip) { media = clip; kind = 'video'; audiogram = true; }
    } catch (e) {
      log(`  WARNING: couldn't make the audio clip: ${e.message}`);
    }
  }
  if (!media) {
    // the same image twice (e.g. the feature image in the gallery too) only counts once
    const same = (u) => u.replace(/\/size\/w\d+(h\d+)?\//, '/').split('?')[0];
    const gallery = GALLERY ? findGalleryImages(post.html, url) : [];
    const urls = [post.feature_image, ...gallery].filter(Boolean)
      .filter((u, i, all) => all.findIndex((v) => same(v) === same(u)) === i);
    if (gallery.length) log(`  found ${gallery.length} gallery image${gallery.length === 1 ? '' : 's'}`);
    if (urls.length > MAX_IMAGES) log(`  using the first ${MAX_IMAGES} of ${urls.length} images (MAX_IMAGES)`);
    // Postiz downloads each image during its request: up to 4 at a time, kept in order
    const todo = urls.slice(0, MAX_IMAGES);
    const done = new Array(todo.length);
    const conv = fitContext(); // for photos made into JPEGs here
    const label = (i) => (i === 0 && post.feature_image ? 'feature image' : `image ${i + 1}`);
    // a photo Postiz refuses, or uploads but can't post (AVIF/BMP/TIFF), goes as a JPEG made here instead
    const asJpeg = async (i, why) => {
      try { return await uploadAsJpeg(todo[i], conv, i); } catch (e) {
        log(`  WARNING: ${label(i)} left out: ${why}, and making it a JPEG failed too (${e.message})`);
        return null;
      }
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (next < todo.length) {
        const i = next++;
        try {
          done[i] = await uploadMedia(todo[i], 'image');
          if (!POSTABLE.test(pathOf(done[i].path))) done[i] = await asJpeg(i, `Postiz can't post ${pathOf(todo[i]).split('/').pop()}`);
        } catch (e) {
          log(`  ${label(i)}: Postiz refused it (${e.message.slice(0, 160)}), so it goes as a JPEG`);
          done[i] = await asJpeg(i, 'Postiz refused it');
        }
      }
    })).finally(conv.done);
    images = done.filter(Boolean);
    if (images.length) { media = images[0]; kind = 'image'; }
  }
  // Each platform's photos, up to its limit, made to fit its rules (IMAGE_RULES): Instagram's feed photos
  // also cropped to one shape at your framing, a Story only the first photo, uncropped
  const uses = (ids) => integrations.some((i) => ids.includes(i.identifier));
  const fit = fitContext();
  const [igFeed, igStory, threadsImages, tiktokImages] = kind !== 'image' ? [[], [], [], []] : await Promise.all([
    uses(INSTAGRAM_IDS) ? fitImages(images.slice(0, IMAGE_LIMITS.instagram), IMAGE_RULES.instagram, fit, { shape: 'first', frames: custom.frames || {} }) : [],
    uses(INSTAGRAM_IDS) && (asStory || bigDrop) ? fitImages(images.slice(0, 1), IMAGE_RULES.instagram, fit) : [],
    uses(['threads']) ? fitImages(images.slice(0, IMAGE_LIMITS.threads), IMAGE_RULES.threads, fit) : [],
    uses(TIKTOK_IDS) ? fitImages(images.slice(0, IMAGE_LIMITS.tiktok), IMAGE_RULES.tiktok, fit) : [],
  ]).finally(fit.done);
  const imagesFor = (idf, story) => {
    if (INSTAGRAM_IDS.includes(idf)) return story ? igStory : igFeed;
    if (idf === 'threads') return threadsImages;
    if (TIKTOK_IDS.includes(idf)) return tiktokImages;
    return images.slice(0, story ? 1 : IMAGE_LIMITS[idf] ?? 4);
  };
  const mediaFor = (idf, story) => (kind === 'image' ? imagesFor(idf, story) : media ? [media] : []);

  // Instagram/TikTok: auto-post only with sound, unless a tag says otherwise
  const { auto: musicAuto, why } = musicRouting(tags, kind, audiogram);
  const pv = previewStore.getStore();
  if (pv) Object.assign(pv, { media: media && { kind, url: media.path, audiogram, count: images.length || 1 }, bigDrop, asStory });
  const addPreview = (integ, label, status, extra = {}) => pv?.entries.push({
    label, idf: integ.identifier, name: integ.name, picture: integ.picture,
    handle: integ.profile || integ.display || '', status,
    media: status === 'skip' ? [] : mediaFor(integ.identifier, label.endsWith(':story')).map((m) => ({ kind, url: m.path, src: m.src })),
    ...extra,
  });
  const captionFor = (idf, story) => (story ? '' : buildLines(idf, say(idf)).join('\n'));

  const hasMusicChannels = integrations.some((i) => INSTAGRAM_IDS.includes(i.identifier) || TIKTOK_IDS.includes(i.identifier));
  if (hasMusicChannels) log(`  Instagram/TikTok: ${musicAuto ? 'auto-post' : 'draft + ntfy'} - ${why}`);
  if (!musicAuto && hasMusicChannels && !NTFY_URL) log('  WARNING: NTFY_URL is not set - you will not be told to post on Instagram/TikTok');

  const manual = []; // [{ platform, idf, drafted }] - platforms you'll finish yourself
  const results = {};
  const post_ = (integ, content, settings, type = 'now', postTags = [], story = false) => ({
    type,
    date: new Date().toISOString(),
    shortLink: false,
    tags: postTags,
    posts: [{
      integration: { id: integ.id },
      // only what Postiz takes: src (the Ghost image, for framing) stays here
      value: [{ content, image: mediaFor(integ.identifier, story).map((m) => ({ id: m.id, path: m.path })) }],
      settings,
    }],
  });

  const mediaLabel = (body) => {
    const n = body.posts[0].value[0].image.length;
    return audiogram ? 'audio clip' : kind === 'image' && n > 1 ? `${n} images` : kind || 'no media';
  };

  for (const integ of integrations) {
    const idf = integ.identifier;
    const isIG = INSTAGRAM_IDS.includes(idf);
    const isTT = TIKTOK_IDS.includes(idf);
    const settings = settingsFor(idf, { story: isIG && asStory });

    if ((isIG || isTT) && !musicAuto) {
      const entry = { platform: isIG ? 'Instagram' : 'TikTok', idf, drafted: false };
      if (!manual.some((m) => m.platform === entry.platform)) manual.push(entry);
      results[idf] = 'manual';
      log(`  ${idf}: draft + ntfy - finish it in the app`);
      addPreview(integ, isIG && asStory ? `${idf}:story` : idf, 'manual', { caption: captionFor(idf, isIG && asStory), why,
        ...(isIG && asStory ? stickerInfo : {}) });
      if (MANUAL_DRAFTS) {
        const draft = post_(integ, isIG && asStory ? '' : buildContent(idf, say(idf)), settings, 'draft',
          DRAFT_TAG ? [{ value: DRAFT_TAG, label: DRAFT_TAG }] : [], isIG && asStory);
        if (isDry()) log(`  [dry run] ${idf} draft (${integ.name})`);
        else {
          try { await postiz('POST', '/posts', draft); entry.drafted = true; log(`  saved ${idf} draft in Postiz (${integ.name}) - it won't publish`); }
          catch (e) { log(`  WARNING: couldn't save the ${idf} draft in Postiz: ${e.message}`); }
        }
      }
      continue;
    }
    if (isIG) {
      if (!media) {
        log(`  skip ${idf}: Instagram needs a video or image`);
        addPreview(integ, idf, 'skip', { why: 'Instagram needs a video or image' });
        continue;
      }
    }
    if (isTT && !media) {
      log(`  skip ${idf}: TikTok needs a video or image`);
      addPreview(integ, idf, 'skip', { why: 'TikTok needs a video or image' });
      continue;
    }
    if ((isIG || isTT) && kind === 'image' && !imagesFor(idf, isIG && asStory).length) {
      log(`  skip ${idf}: none of the photos could be made to fit`);
      addPreview(integ, idf, 'skip', { why: 'none of the photos could be made to fit (see the log)' });
      continue;
    }

    // Stories have no caption (and the API can't add link stickers)
    const content = isIG && asStory ? '' : buildContent(idf, say(idf));
    const jobs = [[isIG && asStory ? `${idf}:story` : idf, post_(integ, content, settings, 'now', [], isIG && asStory)]];
    if (bigDrop && BIG_DROP_AUTO_STORY && isIG && !asStory) {
      jobs.push([`${idf}:story`, post_(integ, '', settingsFor(idf, { story: true }), 'now', [], true)]);
    }

    for (const [label, body] of jobs) {
      addPreview(integ, label, 'auto', { caption: captionFor(idf, label.endsWith(':story')) });
      if (isDry()) {
        log(`  [dry run] ${label} (${integ.name}) with ${mediaLabel(body)}:\n${JSON.stringify(body, null, 2)}`);
        results[label] = 'dry-run';
        continue;
      }
      try {
        await postiz('POST', '/posts', body);
        log(`  queued on ${label} (${integ.name}) with ${mediaLabel(body)}`);
        results[label] = 'ok';
      } catch (e) {
        log(`  ERROR on ${label}: ${e.message}`);
        results[label] = 'error';
      }
    }
  }

  // #bigdrop: the (link-sticker) Story you add by hand (the API can't add stickers)
  const ig = integrations.find((i) => INSTAGRAM_IDS.includes(i.identifier));
  if (pv && bigDrop && ig && media && !asStory && !pv.entries.some((e) => e.label === `${ig.identifier}:story`)) {
    addPreview(ig, `${ig.identifier}:story`, 'manual', { caption: '', ...stickerInfo,
      note: stickerOn ? `${BIG_DROP_TAG}: you add this Story in the app with ${igSticker ? 'a link sticker' : 'its text'} (your ntfy reminder has the media and ${igSticker ? 'link' : 'text'})`
        : `${BIG_DROP_TAG}: you add this Story in the app (your ntfy reminder has the media)` });
  }

  // the first photo shared (a gallery-only post has no feature image)
  const attachment = kind === 'video' ? (media?.path?.startsWith('http') ? media.path : null)
    : kind === 'image' ? images[0]?.src || post.feature_image : null;
  // Stories come in first. #bigdrop: the link Story's own reminder. Not when Instagram's post by hand is a
  // Story (#story): that notification (sent first below) covers it, and not without an Instagram channel.
  // The photo is Instagram's Story version (uncropped).
  const igStoryByHand = asStory && manual.some((m) => m.platform === 'Instagram');
  const failed = Object.entries(results).filter(([, r]) => r === 'error').map(([k]) => k);
  // more to come after a Story notification: wait STORY_GAP_MS so the Story arrives first
  const storyGap = async (more) => { if (more && STORY_GAP_MS) await new Promise((r) => setTimeout(r, STORY_GAP_MS)); };
  if (bigDrop && ig && !igStoryByHand && (manual.length || Object.values(results).some((r) => r === 'ok' || r === 'dry-run'))) {
    if (await notifyBigDrop({ title, url, listen, campaign, stickerUrl: igSticker, stickerText, stickerOn, kind, isClip: audiogram,
      attachment: kind === 'image' && String(igStory[0]?.path).startsWith('http') ? igStory[0].path : attachment })) await storyGap(manual.length || (failed.length && NOTIFY_ERRORS));
  }

  if (manual.length) {
    // one notification per platform, each with what that app needs; an Instagram Story (#story) first
    const storyFirst = (m) => (m.platform === 'Instagram' && asStory ? 0 : 1);
    const ordered = [...manual].sort((a, b) => storyFirst(a) - storyFirst(b));
    for (const [n, m] of ordered.entries()) {
      const sent = await notifyManual({
        platform: m.platform, drafted: m.drafted,
        title, url, listen, campaign, stickerUrl: igSticker, stickerText, bigDrop, stickerOn, story: m.platform === 'Instagram' && asStory, kind, audiogram,
        attachment: m.platform === 'Instagram' && !asStory && igFeed[0] && igFeed[0] !== images[0] && igFeed[0].path.startsWith('http')
          ? igFeed[0].path : attachment,
        count: kind === 'image' ? imagesFor(m.idf, m.platform === 'Instagram' && asStory).length : 1,
        // each photo as that app gets it (Instagram's cropped and scaled), for the extra notifications
        photos: kind === 'image' && !(m.platform === 'Instagram' && asStory)
          ? imagesFor(m.idf, false).map((p) => (String(p.path).startsWith('http') ? p.path : p.src)) : [],
        caption: m.platform === 'Instagram' && asStory ? null : buildLines(m.idf, say(m.idf)).join('\n'),
      });
      if (sent && !storyFirst(m)) await storyGap(n < ordered.length - 1 || (failed.length && NOTIFY_ERRORS));
    }
  }

  if (failed.length && NOTIFY_ERRORS) {
    await notify({
      title: `⚠️ Postiz: "${title}" failed on ${failed.join(', ')}`,
      message: `The bridge couldn't queue the post on ${failed.join(', ')}. Check: docker logs postiz-ghost-bridge`,
      tags: ['warning'],
      priority: 4,
      click: url,
    });
  }

  if (!isDry() && Object.values(results).some((r) => r === 'ok' || r === 'manual')) {
    await recordShared(id, { title, url, at: new Date().toISOString(), media: audiogram ? 'audio-clip' : kind, results });
  }
}

// ---------- Ghost's scheduled posts and where they'll go (GET /upnext.json, Social dashboard's "Up next") ----------
// The bridge shares a post when Ghost publishes it, so Ghost's schedule is the social schedule. For each scheduled
// post: the channels it goes to by itself, the ones you finish in the app, and what's left out, by the same rules
// handlePost follows (tags, media, the connected Postiz channels), without uploading or rendering anything. So a
// photo that can't be made to fit only shows at publish time (and on the post's Social preview, which does it all).
const NETWORK_NAMES = { bluesky: 'Bluesky', threads: 'Threads', instagram: 'Instagram', 'instagram-standalone': 'Instagram',
  tiktok: 'TikTok', 'tiktok-business': 'TikTok' };
let upNext = { at: 0, doc: null };
export async function upNextDoc() {
  if (upNext.doc && Date.now() - upNext.at < 60_000) return upNext.doc;
  const doc = { updatedAt: new Date().toISOString(), posts: [], errors: [] };
  if (!DRAFT_PREVIEWS) {
    doc.errors.push('needs GHOST_API_URL and GHOST_ADMIN_API_KEY (to read the scheduled posts from Ghost)');
    return doc;
  }
  const q = new URLSearchParams({ filter: 'status:scheduled', formats: 'html', include: 'tags', order: 'published_at asc', limit: '50' });
  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/posts/?${q}`, {
    headers: { Authorization: `Ghost ${ghostToken()}`, 'Accept-Version': 'v6.0', 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ghost Admin API -> ${res.status}`);
  const posts = (await res.json()).posts || [];
  let channels = [];
  if (posts.length) {
    try { channels = (await postizChannels()).filter((i) => CHANNELS.includes(i.identifier) && !i.disabled); }
    catch (e) { doc.errors.push(`Postiz channels: ${e.message}`); }
    if (!channels.length && !doc.errors.length) doc.errors.push('no matching Postiz channels (check CHANNELS)');
  }
  const origin = posts.length ? await ghostSiteOrigin().catch(() => '') : '';
  const state = await loadState();
  const customs = await loadCustom();
  const names = (list) => [...new Set(list)].join(', ');
  for (const post of posts) {
    const tags = (post.tags || []).map((t) => (t.name || '').toLowerCase());
    const row = { time: Date.parse(post.published_at) || null, title: (post.title || '').trim(), auto: '', inApp: '', leftOut: '',
      media: '', notes: '', previewText: 'Social preview ›', preview: origin ? `${origin}${DRAFT_BASE}/${post.uuid}/` : '' };
    doc.posts.push(row);
    const skip = ONLY_PUBLIC && post.visibility && post.visibility !== 'public' ? `${post.visibility} post (ONLY_PUBLIC)`
      : tags.includes(SKIP_TAG) ? SKIP_TAG : state[post.id] ? `already shared on ${state[post.id].at.slice(0, 10)}`
        : !post.title ? 'no title' : '';
    if (skip) { Object.assign(row, { leftOut: `everything: ${skip}`, previewText: '', preview: '' }); continue; }

    // the media handlePost would pick: a Ghost video, else an audio card (made into a clip), else the photos
    const url = post.url || origin;
    let kind = null;
    let audiogram = false;
    if (SHARE_VIDEO && findVideo(post.html, url)) { kind = 'video'; row.media = 'video'; }
    else if (AUDIOGRAM && findAudio(post.html, url)) { kind = 'video'; audiogram = true; row.media = 'audio clip'; }
    else {
      const n = new Set([post.feature_image, ...(GALLERY ? findGalleryImages(post.html, url) : [])].filter(Boolean)).size;
      if (n) { kind = 'image'; row.media = `${Math.min(n, MAX_IMAGES)} photo${n === 1 ? '' : 's'}`; } else row.media = 'none';
    }
    const asStory = tags.includes(STORY_TAG);
    const bigDrop = tags.includes(BIG_DROP_TAG);
    const routing = musicRouting(tags, kind, audiogram);
    const auto = [];
    const inApp = [];
    const out = [];
    for (const integ of channels) {
      const idf = integ.identifier;
      const isIG = INSTAGRAM_IDS.includes(idf);
      const isTT = TIKTOK_IDS.includes(idf);
      const name = `${NETWORK_NAMES[idf] || idf}${isIG && asStory ? ' Story' : ''}`;
      if ((isIG || isTT) && !routing.auto) inApp.push(name);
      else if ((isIG || isTT) && !kind) out.push(`${name} (needs a video or photo)`);
      else {
        auto.push(name);
        if (isIG && bigDrop && !asStory && BIG_DROP_AUTO_STORY) auto.push('Instagram Story');
      }
    }
    if (bigDrop && kind && !asStory && channels.some((i) => INSTAGRAM_IDS.includes(i.identifier))) inApp.push(`Instagram link Story (${BIG_DROP_TAG})`);
    Object.assign(row, { auto: names(auto), inApp: names(inApp), leftOut: names(out) });
    const notes = [];
    if (channels.some((i) => INSTAGRAM_IDS.includes(i.identifier) || TIKTOK_IDS.includes(i.identifier))) {
      notes.push(`Instagram/TikTok ${routing.auto ? 'post themselves' : 'in the app'}: ${routing.why}`);
    }
    const campaign = campaignOf(tags);
    if (campaign) notes.push(`campaign ${campaign}`);
    const custom = customs[post.id] || {};
    const own = CUSTOM_CHANNELS.filter((c) => custom[c]);
    if (own.length) notes.push(`own text for ${own.join(', ')}`);
    if (custom.listen) notes.push(`listen link picked: ${custom.listen === 'none' ? 'none' : custom.listen}`);
    if (typeof custom.storyLink === 'boolean') notes.push(`Story sticker ${custom.storyLink ? 'on' : 'off'}`);
    if (custom.stickerLink) notes.push(`sticker link ${custom.stickerLink === 'none' ? 'none' : custom.stickerLink}`);
    if (custom.sticker) notes.push(`sticker text "${custom.sticker}"`);
    row.notes = notes.join('; ');
  }
  upNext = { at: Date.now(), doc };
  return doc;
}
