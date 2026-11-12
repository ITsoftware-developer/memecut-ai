import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const SOURCE_OPTIONS = [
  '-protocol_whitelist', 'file',
  '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
];

export class MediaError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'MediaError';
    this.code = code;
  }
}

async function run(tool, args, { cwd, signal, timeout = 120_000, maxBuffer = 1024 * 1024 } = {}) {
  const binary = process.env[tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] || tool;
  signal?.throwIfAborted();
  try {
    const { stdout } = await exec(binary, ['-hide_banner', '-loglevel', 'error', ...args], {
      cwd, signal, timeout, windowsHide: true, maxBuffer,
    });
    return stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') {
      throw new MediaError(
        tool + ' ontbreekt. Voeg FFmpeg toe aan PATH of stel FFMPEG_PATH en FFPROBE_PATH in.',
        'MEDIA_TOOL_MISSING', error,
      );
    }
    throw new MediaError(
      error.killed ? tool + ' bereikte de verwerkingstijdlimiet.' : tool + ' kon het bestand niet verwerken.',
      'MEDIA_PROCESS_FAILED', error,
    );
  }
}

async function measureDuration(inputPath, startTime, signal) {
  const packets = await run('ffprobe', [
    ...SOURCE_OPTIONS, '-select_streams', 'V:0',
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', inputPath,
  ], { signal, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  let start = Infinity;
  let end = -Infinity;
  for (const line of packets.trim().split('\n')) {
    if (!line.trim()) continue;
    const [timestamp, duration] = line.split(',').map(Number);
    if (!Number.isFinite(timestamp)) continue;
    start = Math.min(start, timestamp);
    end = Math.max(end, timestamp + (Number.isFinite(duration) ? duration : 0));
  }
  return end - (Number.isFinite(startTime) ? startTime : start);
}

export async function probeVideo(inputPath, { signal } = {}) {
  let data;
  const path = resolve(inputPath);
  try {
    const json = await run('ffprobe', [
      ...SOURCE_OPTIONS,
      '-show_entries', 'format=duration,start_time:stream=codec_type,width,height,duration:stream_disposition=attached_pic',
      '-of', 'json', path,
    ], { signal, timeout: 20_000 });
    data = JSON.parse(json);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'MEDIA_TOOL_MISSING') throw error;
    throw new MediaError('Dit bestand is geen leesbare MP4, MOV of WebM.', 'INVALID_VIDEO', error);
  }
  const video = data.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video?.width || !video.height) {
    throw new MediaError('Het bestand heeft geen bruikbare videostream.', 'INVALID_VIDEO');
  }
  if (video.width > 8192 || video.height > 8192 || video.width * video.height > 36_000_000) {
    throw new MediaError('De resolutie van deze video is te groot.', 'INVALID_VIDEO');
  }
  const streamDuration = Number(video.duration);
  let duration = streamDuration > 0 ? streamDuration : Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    try {
      duration = await measureDuration(path, Number(data.format?.start_time), signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new MediaError('FFprobe kon de speelduur van deze video niet bepalen.', 'INVALID_VIDEO', error);
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaError('Het bestand heeft geen bruikbare speelduur.', 'INVALID_VIDEO');
  }
  return {
    duration, width: video.width, height: video.height,
    hasAudio: data.streams.some(stream => stream.codec_type === 'audio'),
  };
}

function seconds(value) {
  return value.toFixed(6);
}

async function findSceneWindows(input, duration, { cwd, signal }) {
  let report;
  try {
    report = await run('ffmpeg', [
      '-nostdin', ...SOURCE_OPTIONS, '-threads', '2', '-t', seconds(duration), '-i', input,
      '-map', '0:V:0', '-an', '-filter_threads', '1',
      '-vf', 'setpts=PTS-STARTPTS,fps=5,scale=160:90:flags=fast_bilinear,scdet,metadata=mode=print:key=lavfi.scd.score:file=-',
      '-f', 'null', '-',
    ], { cwd, signal, timeout: 35_000 });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code !== 'MEDIA_PROCESS_FAILED') throw error;
    return []; // A slow scan or an FFmpeg build without scdet can still supply distributed frames.
  }

  const windows = [];
  for (const match of report.matchAll(/pts_time:(\S+)[ \t]*\r?\nlavfi\.scd\.score=(\S+)/g)) {
    const time = Number(match[1]);
    const score = Number(match[2]);
    if (!Number.isFinite(time) || time < 0 || time >= duration || !Number.isFinite(score) || score < 3) continue;

    const current = windows.at(-1);
    if (current && time - current.start <= 1.25) {
      current.end = time;
      if (score > current.score) {
        current.peak = time;
        current.score = score;
      }
    } else {
      windows.push({ start: time, peak: time, end: time, score });
    }
  }

  windows.sort((first, second) => second.score - first.score || first.start - second.start);
  const first = windows[0];
  if (!first) return [];
  const second = windows.find(window => Math.abs(window.start - first.start) >= 4);
  return second ? [first, second] : [first];
}

async function evidenceTimes(input, duration, options) {
  const distributedCount = Math.min(10, Math.max(6, Math.ceil(duration / 20)));
  // Short sources already have at least one sample per second.
  const windows = duration > distributedCount ? await findSceneWindows(input, duration, options) : [];
  const times = [];
  for (const { start, peak, end } of windows) {
    if (start > 0) times.push(Math.max(0, start - .35));
    times.push(peak);
    const after = Math.min(duration - .2, Math.max(peak + .75, end + .35));
    if (after > end) times.push(after);
  }
  const contextCount = Math.min(distributedCount, 12 - times.length);
  for (let index = 0; index < contextCount; index++) {
    const time = (index + .5) * duration / contextCount;
    if (times.every(nearby => Math.abs(nearby - time) >= .2)) times.push(time);
  }
  return [...new Set(times)].sort((first, second) => first - second);
}

export async function extractEvidence({ inputPath, workDir, duration, signal, hasAudio }) {
  await mkdir(workDir, { recursive: true });
  const cwd = resolve(workDir);
  const input = resolve(inputPath);
  const sourceHasAudio = hasAudio ?? (await probeVideo(input, { signal })).hasAudio;
  let audioPath = null;
  if (sourceHasAudio) {
    audioPath = join(cwd, 'evidence-audio.m4a');
    await run('ffmpeg', [
      '-nostdin', '-y', ...SOURCE_OPTIONS, '-i', input,
      '-map', '0:a:0', '-vn', '-af', 'aresample=16000:async=1:first_pts=0,apad',
      '-t', seconds(duration), '-ac', '1', '-c:a', 'aac', '-b:a', '48k', audioPath,
    ], { cwd, signal });
  }

  const times = await evidenceTimes(input, duration, { cwd, signal });
  const frames = [];
  for (const [index, time] of times.entries()) {
    const path = join(cwd, 'evidence-frame-' + index + '.jpg');
    await run('ffmpeg', [
      '-nostdin', '-y', ...SOURCE_OPTIONS, '-ss', seconds(time), '-i', input,
      '-map', '0:V:0', '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease',
      '-q:v', '4', '-update', '1', path,
    ], { cwd, signal, timeout: 35_000 });
    const info = await stat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.size) frames.push({ time, path });
  }
  if (!frames.length) throw new MediaError('FFmpeg kon geen gameplaybeelden uitlezen.', 'INVALID_VIDEO');
  return { audioPath, frames };
}

// A small pixel font keeps captions usable with FFmpeg builds that omit text filters.
// Each number encodes five pixels of one row.
const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 6, 8, 16, 31], 3: [30, 1, 1, 14, 1, 1, 30],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 16, 30, 1, 1, 30],
  6: [14, 16, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 1, 14],
  '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 6, 4, 0, 4],
  '.': [0, 0, 0, 0, 0, 0, 4], ',': [0, 0, 0, 0, 0, 4, 8],
  ':': [0, 0, 4, 0, 4, 0, 0], ';': [0, 0, 4, 0, 4, 4, 8],
  "'": [4, 4, 0, 0, 0, 0, 0], '"': [10, 10, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '&': [12, 18, 20, 8, 21, 18, 13],
  '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '%': [25, 26, 2, 4, 8, 11, 19], '#': [10, 10, 31, 10, 31, 10, 10],
  '=': [0, 0, 31, 0, 31, 0, 0], '💀': [14, 31, 21, 31, 14, 10, 14],
  '😂': [14, 31, 21, 31, 17, 14, 4], '❤': [0, 10, 31, 31, 31, 14, 4],
};

function captionLines(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
  const supported = [...plain].filter(char => /\s/u.test(char) || Object.hasOwn(GLYPHS, char)).join('');
  const lines = [];
  let line = [];
  for (const word of supported.trim().split(/\s+/u)) {
    const letters = [...word];
    if (!letters.length) continue;
    if (line.length && line.length + letters.length >= 30) {
      lines.push(line);
      line = [];
    }
    while (letters.length > 30) lines.push(letters.splice(0, 30));
    if (line.length) line.push(' ');
    line.push(...letters);
  }
  if (line.length) lines.push(line);
  return lines;
}

async function writeCaption(path, text) {
  const lines = captionLines(text);
  if (!lines.length) return false;
  const step = 6;
  const scale = 6;
  const margin = 5;
  const columns = Math.max(...lines.map(line => line.length));
  const width = (columns * step - 1) * scale + margin * 2;
  const height = (lines.length * 10 - 3) * scale + margin * 2;
  const rgba = Buffer.alloc(width * height * 4);
  const tiles = [];
  lines.forEach((line, row) => line.forEach((char, column) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const left = margin + Math.floor((columns - line.length) * step * scale / 2) + column * step * scale;
    const top = margin + row * 10 * scale;
    glyph.forEach((bits, y) => {
      for (let x = 0; x < 5; x++) {
        if (bits & (16 >> x)) tiles.push([left + x * scale, top + y * scale]);
      }
    });
  }));
  for (const [x, y] of tiles) {
    for (let row = y - margin; row < y + scale + margin; row++) {
      for (let column = x - margin; column < x + scale + margin; column++) {
        rgba.writeUInt32BE(0x15121bf0, (row * width + column) * 4);
      }
    }
  }
  for (const [x, y] of tiles) {
    for (let row = y; row < y + scale; row++) {
      const start = (row * width + x) * 4;
      rgba.fill(255, start, start + scale * 4);
    }
  }
  const header = Buffer.from('P7\nWIDTH ' + width + '\nHEIGHT ' + height
    + '\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n');
  await writeFile(path, Buffer.concat([header, rgba]));
  return true;
}

function piecesForPlan({ segments, edits }) {
  const pieces = [];
  function add(start, end, edit = null) {
    const startFrame = Math.round(start * FPS);
    const endFrame = Math.round(end * FPS);
    if (endFrame > startFrame) pieces.push({ start: startFrame / FPS, frames: endFrame - startFrame, edit });
  }
  for (const segment of segments) {
    let start = segment.start;
    for (const edit of edits) {
      const end = edit.time + edit.duration;
      if (edit.time < segment.start - 1e-6 || end > segment.end + 1e-6) continue;
      const editStart = Math.max(start, edit.time);
      add(start, editStart);
      start = Math.min(segment.end, end);
      add(editStart, start, edit);
    }
    add(start, segment.end);
  }
  return pieces;
}

function sfxFrequency(memeId) {
  switch (memeId) {
    case 'clutch':
    case 'victory':
      return '550+120*t';
    case 'facepalm':
    case 'awkward':
    case 'skill-issue':
    case 'fail':
      return '360-120*t';
    default:
      return '180-145*t';
  }
}

async function renderPiece({ piece, index, input, media, assets, cwd, signal }) {
  const { start, frames, edit } = piece;
  const duration = frames / FPS;
  const args = [
    '-nostdin', '-y', '-filter_complex_threads', '2',
    ...SOURCE_OPTIONS, '-ss', seconds(start), '-threads', '2', '-i', input,
  ];
  let nextInput = 1;
  const filters = [];
  const fit = 'scale=' + WIDTH + ':' + HEIGHT + ':force_original_aspect_ratio=decrease:force_divisible_by=2'
    + ',pad=' + WIDTH + ':' + HEIGHT + ':(ow-iw)/2:(oh-ih)/2,setsar=1';
  const zoom = edit?.zoom ?? 1;
  const crop = zoom > 1 ? ',crop=' + Math.round(WIDTH / zoom / 2) * 2 + ':'
    + Math.round(HEIGHT / zoom / 2) * 2 + ',scale=' + WIDTH + ':' + HEIGHT : '';
  filters.push('[0:V:0]setpts=PTS-STARTPTS,' + fit + crop
    + ',tpad=stop_mode=clone:stop_duration=1,fps=' + FPS
    + ',trim=end_frame=' + frames + ',setsar=1,format=yuv420p[gameplay]');
  let video = 'gameplay';

  if (edit?.memeId) {
    const asset = assets.get(edit.memeId);
    if (!asset?.path) throw new MediaError('Een memeafbeelding ontbreekt in de bibliotheek.', 'MEDIA_ASSET_MISSING');
    args.push('-protocol_whitelist', 'file', '-i', resolve(asset.path));
    const meme = nextInput++;
    const cutaway = edit.mode === 'cutaway';
    const canvas = cutaway ? 'cutaway' : video;
    if (cutaway) filters.push('[' + video + ']drawbox=color=0x15121b:t=fill[cutaway]');
    filters.push('[' + meme + ':v:0]format=rgba,scale=' + (cutaway ? WIDTH + ':' + HEIGHT : '320:220')
      + ':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[meme]');
    const position = cutaway ? '(W-w)/2:(H-h)/2' : 'W-w-36:36';
    filters.push('[' + canvas + '][meme]overlay=' + position + ':eof_action=repeat[withmeme]');
    video = 'withmeme';
  }

  if (edit?.caption && await writeCaption(join(cwd, 'caption-' + index + '.pam'), edit.caption)) {
    args.push('-protocol_whitelist', 'file', '-i', 'caption-' + index + '.pam');
    const caption = nextInput++;
    filters.push('[' + video + '][' + caption + ':v:0]overlay=(W-w)/2:H-h-58:eof_action=repeat[captioned]');
    video = 'captioned';
  }

  const audioFormat = 'aformat=sample_rates=48000:channel_layouts=stereo';
  const audioEnd = 'atrim=end_sample=' + frames * (48000 / FPS) + ',asetpts=PTS-STARTPTS';
  const audioSource = media.hasAudio
    ? '[0:a:0]aresample=48000:async=1:first_pts=0,' + audioFormat + ',apad'
    : 'anullsrc=r=48000:cl=stereo';
  filters.push(audioSource + ',' + audioEnd + '[sourceaudio]');
  let audio = 'sourceaudio';
  if (edit?.sound) {
    const soundPath = edit.memeId ? assets.get(edit.memeId)?.soundPath : null;
    if (soundPath) {
      args.push('-protocol_whitelist', 'file', '-i', resolve(soundPath));
      filters.push('[' + nextInput++ + ':a:0]' + audioFormat + ',asetpts=PTS-STARTPTS[effect]');
    } else {
      const frequency = sfxFrequency(edit.memeId);
      filters.push('aevalsrc=0.72*sin(2*PI*t*(' + frequency
        + '))*exp(-8*t):s=48000:d=' + seconds(Math.min(duration, 0.48)) + ',' + audioFormat + '[effect]');
    }
    filters.push('[sourceaudio][effect]amix=inputs=2:weights=0.85 0.15:normalize=0:duration=first[mix]');
    audio = 'mix';
  }

  const file = 'piece-' + index + '.mkv';
  await run('ffmpeg', [
    ...args, '-filter_complex', filters.join(';'), '-map', '[' + video + ']', '-map', '[' + audio + ']',
    '-t', seconds(duration), '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-map_chapters', '-1', file,
  ], { cwd, signal, timeout: Math.max(90_000, duration * 5000) });
  return { file, duration };
}

export async function renderVideo({ inputPath, outputPath, workDir, media, plan, assets, signal }) {
  signal?.throwIfAborted();
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  const parent = resolve(workDir);
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'render-'));
  try {
    const pieces = piecesForPlan(plan);
    if (!pieces.length) throw new MediaError('Het montageplan bevat geen beeldframes.', 'INVALID_PLAN');
    const files = [];
    for (const [index, piece] of pieces.entries()) {
      files.push(await renderPiece({ piece, index, input, media, assets, cwd, signal }));
    }
    const list = files.map(({ file, duration }) => "file '" + file + "'\nduration " + seconds(duration)).join('\n');
    await writeFile(join(cwd, 'pieces.ffconcat'), 'ffconcat version 1.0\n' + list + '\n');
    await run('ffmpeg', [
      '-nostdin', '-y', '-f', 'concat', '-safe', '1', '-i', 'pieces.ffconcat',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-af', 'aresample=48000:async=1:first_pts=0', '-movflags', '+faststart', 'output.mp4',
    ], { cwd, signal });
    signal?.throwIfAborted();
    const rendered = join(cwd, 'output.mp4');
    try {
      await rename(rendered, output);
    } catch (error) {
      // Windows application sandboxes and separate volumes can reject moves between folders.
      if (!['EPERM', 'EXDEV'].includes(error.code)) throw error;
      await copyFile(rendered, output);
    }
  } finally {
    for (const file of await readdir(cwd)) await unlink(join(cwd, file));
    await rmdir(cwd);
  }
}
