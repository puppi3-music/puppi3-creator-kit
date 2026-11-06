// share/media.mjs's videos: what breaks VIDEO_RULES (videoFixes), the ffmpeg arguments for the fitted copy
// (videoArgs), and fitVideo making one for real from a small clip ffmpeg makes here (skipped without ffmpeg).
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DRY_RUN = 'true'; // uploadFile keeps the copy in the previews folder instead of sending it to Postiz
const { videoFixes, videoArgs, fitVideo } = await import('../ghost-bridge/share/media.mjs');
const { previewStore, PREVIEW_DIR } = await import('../ghost-bridge/config.mjs');

const video = (o = {}) => ({ index: 0, codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '30/1', pix_fmt: 'yuv420p', ...o });
const audio = (o = {}) => ({ index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', ...o });

test('a video that fits every network goes as it is', () => {
  assert.equal(videoFixes({ streams: [video(), audio()] }), null);
  assert.equal(videoFixes({ streams: [video({ codec_name: 'hevc', width: 1920, height: 1080, r_frame_rate: '60000/1001' })] }), null, 'HEVC, no sound');
  assert.equal(videoFixes({ streams: [] }), null, 'nothing ffprobe could read');
  assert.equal(videoFixes({ streams: [video(), audio(), { index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] })?.extra.length, 1,
    'a cover picture inside the file is a track to drop');
});

test('what breaks a rule: size, codec, frame rate, 10-bit, the audio, extra tracks', () => {
  const f = videoFixes({ streams: [video({ codec_name: 'vp9', width: 3840, height: 2160, r_frame_rate: '120/1', pix_fmt: 'yuv420p10le' }),
    audio({ codec_name: 'flac', sample_rate: '96000' }), { index: 2, codec_type: 'data' }] });
  assert.deepEqual(f.video, ['VP9 video', '3840x2160', '120 fps', 'yuv420p10le']);
  assert.deepEqual(f.audio, ['FLAC audio', '96 kHz']);
  assert.equal(f.extra.length, 1);
});

test('ffmpeg re-encodes only what breaks a rule, keeping one video and one audio track', () => {
  const only = videoFixes({ streams: [video(), audio({ codec_name: 'flac' }), { index: 2, codec_type: 'data' }] });
  const args = videoArgs('in.mp4', only, 'out.mp4');
  assert.deepEqual(args.slice(args.indexOf('-map')), ['-map', '0:0', '-map', '0:1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-map_metadata', '-1', '-movflags', '+faststart', 'out.mp4'], 'the picture copied, the sound made AAC');
  const big = videoArgs('in.mp4', videoFixes({ streams: [video({ width: 3840, height: 2160 }), audio()] }), 'out.mp4');
  assert.ok(big.includes('scale=1920:1920:force_original_aspect_ratio=decrease:force_divisible_by=2'), 'fitted after the camera\'s rotation');
  assert.deepEqual(big.slice(big.indexOf('-c:a'), big.indexOf('-c:a') + 2), ['-c:a', 'copy']);
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('fitVideo makes the copy: a 2400x1200 clip with FLAC audio and a data track comes out 1920x960 H.264 + AAC', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-test-'));
  after(() => fs.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'clip.mp4');
  const sub = path.join(dir, 'tag.srt');
  await fs.writeFile(sub, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2400x1200:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', sub, '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'mpeg4', '-c:a', 'flac', '-strict', '-2', '-c:s', 'mov_text', src]);
  const pv = { draft: false, log: [], entries: [], notes: [], files: [], base: 'https://example.com/previews' };
  const out = await previewStore.run(pv, () => fitVideo(src, 'new-mix'));
  assert.match(out.fixed, /^MPEG4 video, 2400x1200, FLAC audio, 1 extra track -> H\.264 at most 1920, AAC$/);
  const made = path.join(PREVIEW_DIR, pv.files[0]);
  after(() => fs.rm(made, { force: true }));
  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', made])).streams;
  assert.deepEqual(streams, [{ codec_name: 'h264', width: 1920, height: 960 }, { codec_name: 'aac' }]);
});
