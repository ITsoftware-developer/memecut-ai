import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as media from './media.mjs';
import { analyzeGameplay } from './ai.mjs';
import { validatePlan } from './plan.mjs';

const defaultWebRoot = fileURLToPath(new URL('./web/', import.meta.url));
const maxUpload = 256 * 1024 * 1024;
const jobTtl = 60 * 60 * 1000;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
};

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function loadCatalog(webRoot) {
  const directory = join(webRoot, 'assets', 'memes');
  const list = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8'));
  if (!Array.isArray(list) || !list.length) throw new Error('De memebibliotheek is leeg.');
  const assets = new Map();
  for (const item of list) {
    if (typeof item?.id !== 'string' || typeof item.file !== 'string' ||
        !/^[a-z0-9-]+\.png$/.test(item.file) || assets.has(item.id)) {
      throw new Error('De memebibliotheek bevat een ongeldige afbeelding.');
    }
    const path = join(directory, item.file);
    if (!(await stat(path)).isFile()) throw new Error('Een memeafbeelding ontbreekt.');
    assets.set(item.id, { path });
  }
  return { list, assets };
}

async function consume(req, maxSize, write) {
  const size = Number(req.headers['content-length'] ?? 0);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxSize) {
    req.resume();
    throw new HttpError(413, 'too_large', 'Het bestand of plan is te groot.');
  }
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > maxSize) {
      req.resume();
      throw new HttpError(413, 'too_large', 'Het bestand of plan is te groot.');
    }
    await write(chunk);
  }
  if (!total) throw new HttpError(400, 'empty_body', 'Het bestand of plan is leeg.');
}

async function saveUpload(req, path) {
  if (req.headers['content-type'] !== 'application/octet-stream') {
    req.resume();
    throw new HttpError(415, 'upload_type', 'Stuur het videobestand als binaire upload.');
  }
  const file = await open(path, 'wx');
  try {
    await consume(req, maxUpload, chunk => file.writeFile(chunk));
  } finally {
    await file.close();
  }
}

async function readPlan(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    req.resume();
    throw new HttpError(415, 'plan_type', 'Stuur het montageplan als JSON.');
  }
  const chunks = [];
  await consume(req, 64 * 1024, chunk => { chunks.push(chunk); });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Het montageplan bevat ongeldige JSON.');
  }
}

function checkRequest(req) {
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(host)) {
    throw new HttpError(403, 'host', 'Open MemeCut op localhost.');
  }
  if ((req.headers.origin && req.headers.origin !== 'http://' + host) ||
      (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site')) {
    throw new HttpError(403, 'origin', 'Open de editor op hetzelfde lokale adres als de server.');
  }
}

async function streamFile(res, path, contentType, headers = {}) {
  const info = await stat(path).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new HttpError(404, 'not_found', 'Bestand niet gevonden.');
    }
    throw error;
  });
  if (!info.isFile()) throw new HttpError(404, 'not_found', 'Bestand niet gevonden.');
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': info.size, ...headers });
  await pipeline(createReadStream(path), res);
}

async function serveWeb(res, pathname, webRoot) {
  let name;
  try {
    name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    throw new HttpError(400, 'invalid_path', 'Ongeldig pad.');
  }
  const path = resolve(webRoot, name);
  const type = mimeTypes[extname(path)];
  if (!path.startsWith(webRoot + sep) || !type) throw new HttpError(404, 'not_found', 'Bestand niet gevonden.');
  await streamFile(res, path, type, { 'Cache-Control': 'no-cache' });
}

function mediaFailure(error, action) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return error;
  if (error.code === 'ENOENT' || error.cause?.code === 'ENOENT' ||
      ['ffmpeg_not_found', 'ffprobe_not_found', 'MEDIA_TOOL_MISSING'].includes(error.code)) {
    return new HttpError(503, 'missing_ffmpeg', 'FFmpeg of FFprobe ontbreekt. Stel FFMPEG_PATH en FFPROBE_PATH in.');
  }
  return action === 'probe'
    ? new HttpError(422, 'invalid_video', 'Dit bestand bevat geen leesbare gameplayvideo.')
    : new HttpError(422, 'media_error', 'FFmpeg kon deze video niet ' + action + '. Controleer het bronbestand en probeer het opnieuw.');
}

export async function createEditorServer({
  webRoot = defaultWebRoot,
  tempRoot = tmpdir(),
  mediaApi = media,
  analyze = analyzeGameplay,
  aiEnabled = Boolean(process.env.OPENAI_API_KEY?.trim()),
} = {}) {
  webRoot = resolve(webRoot);
  const { list, assets } = await loadCatalog(webRoot);
  const jobs = new Map();
  let uploading = 0;

  function discard(path) {
    // Only the private job and operation directories created below reach this function.
    return rm(path, { recursive: true, force: true }).catch(() => {});
  }

  const sweeper = setInterval(() => {
    for (const [id, job] of jobs) {
      if (!job.busy && Date.now() - job.touched > jobTtl) {
        jobs.delete(id);
        void discard(job.root);
      }
    }
  }, 60000);
  sweeper.unref();

  async function createProject(req, res, signal) {
    if (jobs.size + uploading >= 8 || uploading >= 2) {
      req.resume();
      throw new HttpError(429, 'busy', 'Er zijn te veel geopende projecten of uploads.');
    }
    uploading += 1;
    let root;
    let committed = false;
    try {
      root = await mkdtemp(join(tempRoot, 'memecut-project-'));
      const inputPath = join(root, 'source.video');
      await saveUpload(req, inputPath);
      signal.throwIfAborted();
      const info = await mediaApi.probeVideo(inputPath, { signal }).catch(error => {
        throw mediaFailure(error, 'probe');
      });
      if (!Number.isFinite(info.duration) || info.duration < 119.95 || info.duration > 600.05) {
        throw new HttpError(422, 'duration', 'Kies gameplay van 2 tot 10 minuten.');
      }
      const id = randomUUID();
      jobs.set(id, { id, root, inputPath, media: info, touched: Date.now(), renders: new Map(), busy: false });
      committed = true;
      json(res, 201, { id, media: info });
    } finally {
      uploading -= 1;
      if (root && !committed) await discard(root);
    }
  }

  async function processJob(req, res, job, action, signal) {
    if (job.busy) {
      req.resume();
      throw new HttpError(409, 'busy', 'Er loopt al een analyse of render voor dit project.');
    }
    job.busy = true;
    let workDir;
    try {
      const duration = job.media.duration;
      const rules = { duration, memeIds: assets };
      if (action === 'analyze') {
        if (!aiEnabled) throw new HttpError(503, 'ai_unavailable', 'Stel OPENAI_API_KEY in op de server om AI-analyse te gebruiken.');
        workDir = await mkdtemp(join(job.root, 'analysis-'));
        const evidence = await mediaApi.extractEvidence({
          inputPath: job.inputPath, workDir, duration, hasAudio: job.media.hasAudio, signal,
        }).catch(error => { throw mediaFailure(error, 'analyseren'); });
        const suggestion = await analyze({ evidence, duration, catalog: list, signal });
        const plan = validatePlan(suggestion, { ...rules, automatic: true });
        await discard(workDir);
        workDir = undefined;
        json(res, 200, { plan });
        return;
      }

      const plan = validatePlan(await readPlan(req), rules);
      workDir = await mkdtemp(join(job.root, 'render-'));
      const outputPath = join(workDir, 'montage.mp4');
      await mediaApi.renderVideo({
        inputPath: job.inputPath, outputPath, workDir, media: job.media, plan, assets, signal,
      }).catch(error => { throw mediaFailure(error, 'renderen'); });
      signal.throwIfAborted();
      const renderId = randomUUID();
      job.renders.set(renderId, outputPath);
      workDir = undefined;
      if (job.renders.size > 3) {
        const [id, path] = job.renders.entries().next().value;
        job.renders.delete(id);
        void discard(dirname(path));
      }
      json(res, 201, { download: '/api/projects/' + job.id + '/renders/' + renderId, duration: plan.outputDuration });
    } finally {
      if (workDir) await discard(workDir);
      job.touched = Date.now();
      job.busy = false;
    }
  }

  async function route(req, res, signal) {
    checkRequest(req);
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (pathname === '/api/status' && method === 'GET') {
      json(res, 200, { version: '0.2', ai: aiEnabled, maxUpload, catalog: list });
      return;
    }
    if (pathname === '/api/projects' && method === 'POST') {
      await createProject(req, res, signal);
      return;
    }
    const match = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(analyze|render|renders\/([a-f0-9-]{36})))?$/.exec(pathname);
    if (match) {
      const [, id, action, renderId] = match;
      const job = jobs.get(id);
      if (!job) throw new HttpError(404, 'project_missing', 'Je lokale project is verlopen. Importeer de video opnieuw.');
      job.touched = Date.now();
      if (method === 'POST' && (action === 'analyze' || action === 'render')) {
        await processJob(req, res, job, action, signal);
        return;
      }
      if (method === 'GET' && renderId && job.renders.has(renderId)) {
        await streamFile(res, job.renders.get(renderId), 'video/mp4', {
          'Content-Disposition': 'attachment; filename="memecut-montage.mp4"',
          'Cache-Control': 'no-store',
        });
        return;
      }
      if (method === 'DELETE' && !action) {
        if (job.busy) throw new HttpError(409, 'busy', 'Dit project is nog bezig.');
        jobs.delete(id);
        await discard(job.root);
        res.writeHead(204).end();
        return;
      }
    }
    if (pathname.startsWith('/api/') || method !== 'GET') {
      req.resume();
      throw new HttpError(404, 'not_found', 'Route niet gevonden.');
    }
    await serveWeb(res, pathname, webRoot);
  }

  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await route(req, res, AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60000)]));
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error.name === 'TimeoutError' ? 504 : error.statusCode;
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        json(res, status, { code: error.code ?? 'timeout', error: status === 504 ? 'Deze bewerking duurde te lang.' : error.message });
      } else {
        json(res, 500, { code: 'internal', error: 'De editor kon dit verzoek niet verwerken.' });
      }
    }
  });
  server.once('close', () => {
    clearInterval(sweeper);
    for (const job of jobs.values()) void discard(job.root);
    jobs.clear();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8765);
  const server = await createEditorServer();
  server.listen(port, '127.0.0.1', () => console.log('MemeCut AI draait op http://127.0.0.1:' + server.address().port));
  function stop() {
    server.close();
    server.closeAllConnections();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
