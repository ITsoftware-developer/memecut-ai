import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractEvidence, probeVideo, renderVideo } from '../src/media.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const toolsAvailable = [ffmpeg, ffprobe].every(tool =>
  spawnSync(tool, ['-version'], { windowsHide: true }).status === 0);

function command(binary, args) {
  const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
  return result.stdout;
}

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'memecut-media-'));
  context.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  return directory;
}

function createVideo(path, audio = false) {
  const args = [
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3',
    '-vf', "drawbox=color=yellow:t=fill:enable='gte(t,2)'",
  ];
  if (audio) args.splice(4, 0, '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3');
  command(ffmpeg, [
    ...args, '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : []), path,
  ]);
}

function pixel(path, time, x, y) {
  return command(ffmpeg, [
    '-ss', String(time), '-i', path, '-vf', 'crop=2:2:' + x + ':' + y + ',format=rgb24',
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ]).subarray(0, 3);
}

test('FFmpeg renders cuts, raster overlays, captions, cutaways and audio reproducibly', {
  skip: !toolsAvailable && 'Set FFMPEG_PATH and FFPROBE_PATH or add FFmpeg to PATH.',
}, async context => {
  const workDir = await fixture(context);
  const inputPath = join(workDir, 'source.mp4');
  createVideo(inputPath, true);
  const media = await probeVideo(inputPath);
  assert.deepEqual(media, { duration: 3, width: 320, height: 180, hasAudio: true });

  const evidence = await extractEvidence({ inputPath, workDir, duration: media.duration });
  assert.ok((await stat(evidence.audioPath)).size > 0);
  assert.equal(evidence.frames.length, 6);
  assert.deepEqual(evidence.frames.map(frame => frame.time), [0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);

  const image = join(workDir, 'red.ppm');
  const redPixels = Buffer.alloc(96 * 64 * 3);
  for (let index = 0; index < redPixels.length; index += 3) redPixels[index] = 255;
  await writeFile(image, Buffer.concat([Buffer.from('P6\n96 64\n255\n'), redPixels]));
  const outputPath = join(workDir, 'result.mp4');
  const plan = {
    segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }],
    edits: [
      { time: 0.2, duration: 0.5, memeId: 'red', caption: 'YES!', zoom: 1.2, sound: true, mode: 'overlay' },
      { time: 2.3, duration: 0.4, memeId: 'red', caption: '', zoom: 1, sound: false, mode: 'cutaway' },
    ],
  };
  const assets = new Map([['red', { path: image }]]);
  const render = () => renderVideo({ inputPath, outputPath, workDir, media, plan, assets });
  await render();
  const result = await probeVideo(outputPath);
  assert.deepEqual(result, { duration: 2, width: 1280, height: 720, hasAudio: true });
  const codecs = command(ffprobe, [
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outputPath,
  ]).toString().trim().split(/\s+/);
  assert.deepEqual(codecs, ['h264', 'aac']);

  const overlay = pixel(outputPath, 0.45, 1190, 110);
  assert.ok(overlay[0] > 220 && overlay[1] < 25 && overlay[2] < 25);
  const plain = pixel(outputPath, 0.85, 1190, 110);
  assert.ok(plain[2] > 220 && plain[0] < 25);
  const cutaway = pixel(outputPath, 1.5, 640, 360);
  assert.ok(cutaway[0] > 220 && cutaway[1] < 25);
  const retained = pixel(outputPath, 1.9, 640, 360);
  assert.ok(retained[0] > 220 && retained[1] > 220 && retained[2] < 25);

  const captionArea = command(ffmpeg, [
    '-ss', '0.45', '-i', outputPath, '-vf', 'crop=200:70:540:600,format=rgb24',
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ]);
  let whitePixels = 0;
  for (let index = 0; index < captionArea.length; index += 3) {
    if (captionArea[index] > 220 && captionArea[index + 1] > 220 && captionArea[index + 2] > 220) whitePixels++;
  }
  assert.ok(whitePixels > 100, 'the caption must appear in the rendered video');
  const firstOutput = await readFile(outputPath);
  await render();
  assert.deepEqual(await readFile(outputPath), firstOutput);
});

test('a silent source exports with AAC and rejects invalid uploads', {
  skip: !toolsAvailable && 'Set FFMPEG_PATH and FFPROBE_PATH or add FFmpeg to PATH.',
}, async context => {
  const workDir = await fixture(context);
  const inputPath = join(workDir, 'silent.mp4');
  createVideo(inputPath);
  const media = await probeVideo(inputPath);
  assert.equal(media.hasAudio, false);
  const evidence = await extractEvidence({ inputPath, workDir, duration: media.duration, hasAudio: false });
  assert.equal(evidence.audioPath, null);
  assert.equal(evidence.frames.length, 6);
  const outputPath = join(workDir, 'with-sfx.mp4');
  await renderVideo({
    inputPath, outputPath, workDir, media, assets: new Map(),
    plan: {
      segments: [{ start: 2, end: 3 }],
      edits: [{ time: 2.8, duration: 0.2, memeId: null, caption: '', zoom: 1, sound: true, mode: 'overlay' }],
    },
  });
  assert.deepEqual(await probeVideo(outputPath), { duration: 1, width: 1280, height: 720, hasAudio: true });
  const sound = command(ffmpeg, ['-i', outputPath, '-map', '0:a:0', '-f', 's16le', '-']);
  assert.ok(sound.some(byte => byte !== 0), 'the sound effect must be present');
  const invalidPath = join(workDir, 'invalid.mp4');
  await writeFile(invalidPath, 'not a video');
  await assert.rejects(probeVideo(invalidPath), { code: 'INVALID_VIDEO' });
});

test('video packet timestamps recover the duration of a streaming WebM file', {
  skip: !toolsAvailable && 'Set FFMPEG_PATH and FFPROBE_PATH or add FFmpeg to PATH.',
}, async context => {
  const workDir = await fixture(context);
  const inputPath = join(workDir, 'recording.webm');
  command(ffmpeg, [
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=3',
    '-c:v', 'libvpx-vp9', '-threads', '2', '-live', '1', '-f', 'webm', inputPath,
  ]);
  const media = await probeVideo(inputPath);
  assert.ok(Math.abs(media.duration - 3) <= 1 / 30);
  assert.deepEqual({ ...media, duration: 3 }, { duration: 3, width: 160, height: 90, hasAudio: false });
});
