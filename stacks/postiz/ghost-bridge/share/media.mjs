// share/media.mjs: the photos and video a post shares: photos made to fit each platform (ffmpeg: type, size, Instagram's
// crop) and the audio clip ("audiogram") made from an audio card.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { STATE_FILE, PREVIEW_DIR, DRAFT_BASE, CLIP_SECONDS, CLIP_DEFAULT_START, previewStore, log,
  isDry } from '../config.mjs';
import { uploadFile } from '../services.mjs';
import { findAudio, findAudioThumb, clipFromTags } from './content.mjs';

// A photo Postiz won't take as it is (it refused its address, e.g. an extension like .HEIC, or it can't
// post the type, e.g. AVIF): made a JPEG here and uploaded. Previews just say it would be.
export async function uploadAsJpeg(src, ctx, i) {
  if (isDry()) { log(`  image ${i + 1} would be made a JPEG for Postiz`); return { id: 'dry-run', path: src, src }; }
  const file = path.join(ctx.dir(), `upload-${i + 1}.jpg`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '2', file], 60_000);
  const up = await uploadFile(file, `photo-${i + 1}.jpg`, 'image/jpeg');
  log(`  image ${i + 1}: made a JPEG (${pathOf(src).split('/').pop()}) -> ${up.path}`);
  return { ...up, src };
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

async function audioDuration(url) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url], 60_000);
    const d = parseFloat(out);
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

// The artwork as a local file (looping a remote image makes ffmpeg re-fetch it every frame)
async function downloadArtwork(imageUrl, dir) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`artwork download failed: ${res.status}`);
  const file = path.join(dir, 'art' + (path.extname(new URL(imageUrl).pathname) || '.img'));
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// Width and height as shown (a photo stored sideways with a rotation tag counts as turned, as it does
// for browsers and for ffmpeg's crop). A JPEG's EXIF orientation shows up on its frame, not its stream.
async function imageSize(url) {
  try {
    const out = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
      '-show_entries', 'frame=width,height:frame_side_data=rotation', '-of', 'json', url], 60_000)).frames?.[0];
    if (!out?.width) return null;
    const turned = Math.abs(out.side_data_list?.find((d) => 'rotation' in d)?.rotation || 0) % 180 === 90;
    return turned ? { w: out.height, h: out.width } : { w: out.width, h: out.height };
  } catch { return null; }
}

// What each platform takes, per its API docs. Postiz passes image addresses straight through (it only
// shrinks Bluesky's to fit), so a photo it can't use gets the whole post for that channel refused:
// - Postiz itself posts only .png .jpg .jpeg .gif .webp (it uploads AVIF/BMP/TIFF, but won't post them)
// - Instagram (Meta): JPEG only, at most 1440 wide and 8 MB; a feed post in one shape, 4:5 to 1.91:1
// - Threads (Meta): JPEG or PNG (it scales the width itself)
// - TikTok: JPEG or WebP, and Postiz refuses a photo whose shorter side is over 1080
export const POSTABLE = /\.(png|jpe?g|gif|webp)$/i;
export const IMAGE_RULES = {
  instagram: { name: 'instagram', types: /\.jpe?g$/i, maxWidth: 1440 },
  threads: { name: 'threads', types: /\.(jpe?g|png)$/i },
  tiktok: { name: 'tiktok', types: /\.(jpe?g|webp)$/i, maxShort: 1080 },
};
export const pathOf = (u) => String(u || '').split('?')[0];
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Makes each photo fit a platform's rules: the ones that don't are turned into a JPEG with ffmpeg
// (cropped and/or scaled down as needed) and uploaded; the rest are sent as they are. With
// shape 'first' (Instagram's feed) every photo is cropped to the first one's shape, kept between
// 4:5 and 1.91:1, where it was placed on the Social preview (frames), else centred, so the post
// matches the preview. ctx is shared by one post's platforms, so each photo is measured once and the
// same conversion is made once. Previews skip all this (they show Instagram's crop with CSS).
export async function fitImages(list, rules, ctx, { shape = null, frames = {} } = {}) {
  if (isDry() || !list.length) return list;
  const sizeOf = (src) => {
    if (!ctx.sizes.has(src)) ctx.sizes.set(src, imageSize(src));
    return ctx.sizes.get(src);
  };
  const dims = await Promise.all(list.map((m) => sizeOf(m.src)));
  const ratio = shape === 'first' && dims[0] ? Math.min(1.91, Math.max(0.8, dims[0].w / dims[0].h)) : null;
  const out = await Promise.all(list.map(async (m, i) => {
    const d = dims[i];
    const typeOk = rules.types.test(pathOf(m.path));
    let crop = null;
    if (ratio && d && Math.abs(d.w / d.h - ratio) >= 0.01) {
      const [fx, fy] = (frames[m.src] || [50, 50]).map((v) => v / 100);
      const w = d.w / d.h > ratio ? Math.round(d.h * ratio) : d.w;
      const h = d.w / d.h > ratio ? d.h : Math.round(d.w / ratio);
      crop = { w, h, x: Math.round((d.w - w) * fx), y: Math.round((d.h - h) * fy), placed: !!frames[m.src] };
    }
    const w0 = crop ? crop.w : d?.w;
    const h0 = crop ? crop.h : d?.h;
    const factor = d ? Math.min(1, rules.maxWidth ? rules.maxWidth / w0 : 1, rules.maxShort ? rules.maxShort / Math.min(w0, h0) : 1) : 1;
    const scale = factor < 1 ? { w: even(w0 * factor), h: even(h0 * factor) } : null;
    if (typeOk && !crop && !scale) return m;
    const key = JSON.stringify([m.src, crop, scale]);
    if (!ctx.made.has(key)) {
      ctx.made.set(key, (async () => {
        const file = path.join(ctx.dir(), `photo-${ctx.made.size}.jpg`);
        const vf = [crop && `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, scale && `scale=${scale.w}:${scale.h}`].filter(Boolean);
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', m.src, ...(vf.length ? ['-vf', vf.join(',')] : []),
          '-frames:v', '1', '-q:v', '2', file], 60_000);
        return uploadFile(file, `${rules.name}-${i + 1}.jpg`, 'image/jpeg');
      })());
    }
    try {
      const up = await ctx.made.get(key);
      const what = [crop && `cropped to ${crop.w}x${crop.h} at ${crop.x},${crop.y} (${crop.placed ? 'as you placed it' : 'centred'})`,
        scale && `scaled to ${scale.w}x${scale.h}`, !typeOk && 'made a JPEG'].filter(Boolean).join(', ');
      log(`  ${rules.name}: photo ${i + 1} ${what}`);
      return { ...up, src: m.src };
    } catch (e) {
      log(`  WARNING: ${rules.name}: couldn't fit photo ${i + 1} (${e.message}), so it's left out`);
      return null;
    }
  }));
  return out.filter(Boolean);
}
// A temporary folder for one post's converted photos, made when first needed
export function fitContext() {
  let dir = null;
  return {
    sizes: new Map(), made: new Map(),
    dir: () => dir || (dir = mkdtempSync(path.join(os.tmpdir(), 'photos-'))),
    done: () => dir && fs.rm(dir, { recursive: true, force: true }),
  };
}

// Render a 1080x1920 MP4 in dir: blurred artwork background, artwork in the middle, live waveform below.
async function renderAudiogram({ audioUrl, imgFile, dir, start, length }) {
  const out = path.join(dir, 'clip.mp4');
  const fadeOut = Math.max(0, length - 1.5);
  // 1) the static part (blurred background + centred artwork) is rendered once as a still
  const baseFile = path.join(dir, 'base.png');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', imgFile,
    '-filter_complex',
    '[0:v]split=2[a][b];' +
    '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:4,eq=brightness=-0.18[bg];' +
    '[b]scale=900:900:force_original_aspect_ratio=decrease[art];' +
    '[bg][art]overlay=(W-w)/2:(H-h)/2-160,' +
    'drawbox=x=40:y=1390:w=1000:h=260:color=black@0.35:t=fill',
    '-frames:v', '1', baseFile,
  ], 60_000);
  // 2) animate only the waveform over the still, with the audio snippet
  const filter = [
    `[1:a]afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5,asplit=2[aout][awave]`,
    '[awave]showwaves=s=960x200:mode=cline:scale=sqrt:rate=30:colors=white@0.95,format=rgba[wave]',
    '[0:v][wave]overlay=(W-w)/2:H-h-300:format=auto,format=yuv420p[v]',
  ].join(';');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', '30', '-i', baseFile,
    '-ss', String(start), '-t', String(length), '-i', audioUrl,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23', '-r', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-t', String(length), '-shortest', '-movflags', '+faststart',
    out,
  ];
  await run('ffmpeg', args, 5 * 60_000);
  return out;
}

// Draft previews: clips by what they're made from, so editing the post's text (Ghost autosaves, which
// changes updated_at) doesn't render the same clip again. Newest last; the oldest files are removed.
const clipCache = new Map();
const CLIP_CACHE_SIZE = 10;

export async function makeAudiogram(post, url, tagNames, { maxLength = 90 } = {}) {
  const audioUrl = findAudio(post.html, url);
  if (!audioUrl) return null;
  const imageUrl = post.feature_image || findAudioThumb(post.html, url);
  if (!imageUrl) { log('  found audio but no artwork (feature image or audio card thumbnail) - skipping audiogram'); return null; }

  const fromTag = clipFromTags(tagNames);
  const memo = previewStore.getStore()?.draft
    ? JSON.stringify([audioUrl, imageUrl, fromTag, maxLength, CLIP_SECONDS, CLIP_DEFAULT_START]) : null;
  const hit = memo && clipCache.get(memo);
  if (hit && await fs.stat(hit.file).then(() => true, () => false)) {
    clipCache.delete(memo); clipCache.set(memo, hit);
    log('  audio clip: unchanged since the last preview');
    return hit.result;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiogram-'));
  try {
    // fetch the artwork while ffprobe reads the audio's length
    const artwork = downloadArtwork(imageUrl, dir);
    artwork.catch(() => {}); // awaited below; this only stops an early failure being reported as unhandled
    const clip = await clipRange(audioUrl, fromTag, maxLength);
    const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    log(`  rendering audiogram: ${fmt(clip.start)}-${fmt(clip.start + clip.length)}${fromTag ? ' (from tag)' : ''} of ${audioUrl.split('/').pop()}`);
    const t0 = Date.now();
    const file = await renderAudiogram({ audioUrl, imgFile: await artwork, dir, ...clip });
    const size = (await fs.stat(file)).size;
    log(`  audiogram ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(size / 1048576).toFixed(1)} MB)`);
    await fs.copyFile(file, path.join(path.dirname(STATE_FILE), 'audiogram-latest.mp4')).catch(() => {});
    const slug = (post.slug || 'clip').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'clip';
    const result = await uploadFile(file, `${slug}-clip.mp4`, 'video/mp4');
    if (memo) {
      clipCache.set(memo, { result, file: path.join(PREVIEW_DIR, result.path.slice(DRAFT_BASE.length + 1)) });
      for (const [k, old] of clipCache) {
        if (clipCache.size <= CLIP_CACHE_SIZE) break;
        clipCache.delete(k);
        await fs.rm(old.file, { force: true });
      }
    }
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Which part of the audio to use: a short upload whole, else CLIP_SECONDS from CLIP_DEFAULT_START or a #clip tag
async function clipRange(audioUrl, fromTag, maxLength) {
  const duration = await audioDuration(audioUrl);
  let start;
  let length;
  if (!fromTag && duration && duration <= maxLength) {
    // a short clip uploaded to Ghost is used whole
    start = 0;
    length = Math.floor(duration * 10) / 10;
  } else {
    start = fromTag ? fromTag.start : CLIP_DEFAULT_START;
    length = Math.min(fromTag?.length || CLIP_SECONDS, maxLength);
    if (duration && start + length > duration) start = Math.max(0, duration - length);
  }
  return { start, length };
}
