import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEditorServer } from '../src/server.mjs';

const video = Buffer.from('synthetic upload');
const renderBytes = Buffer.from('stub renderer output');
const mediaInfo = { duration: 180, width: 1920, height: 1080, hasAudio: true };
const gameplayPlan = { segments: [{ start: 0, end: 180 }], edits: [] };

function binaryRequest(body = video) {
  return { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body };
}

function jsonRequest(value) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function startServer(t, options = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'memecut-server-test-'));
  let server;
  t.after(async () => {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  });
  server = await createEditorServer({
    tempRoot,
    aiEnabled: false,
    ...options,
    mediaApi: {
      async probeVideo(inputPath) {
        assert.deepEqual(await readFile(inputPath), video);
        return mediaInfo;
      },
      async renderVideo({ outputPath }) {
        await writeFile(outputPath, renderBytes);
      },
      ...options.mediaApi,
    },
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const url = 'http://127.0.0.1:' + server.address().port;
  return (path, request) => fetch(url + path, request);
}

async function expectJson(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  if (code) assert.equal(body.code, code);
  return body;
}

async function importVideo(request) {
  const project = await expectJson(await request('/api/projects', binaryRequest()), 201);
  assert.deepEqual(project.media, mediaInfo);
  return '/api/projects/' + project.id;
}

test('imports, analyzes, validates edited cuts and renders the same plan twice', async t => {
  const evidence = { audioPath: 'test-audio.mp3', frames: [{ time: 12, path: 'test-frame.jpg' }] };
  const edits = [{ time: 12, duration: 1.5, memeId: 'faceplant', caption: 'Oeps!', zoom: 1.12,
    mode: 'overlay', sound: true, reason: 'Mislukte sprong' }];
  const suggestion = { segments: [{ start: 0, end: 180 }], edits };
  const rendered = [];
  const request = await startServer(t, {
    aiEnabled: true,
    async analyze({ evidence: input, duration, catalog }) {
      assert.deepEqual(input, evidence);
      assert.equal(duration, 180);
      assert.equal(catalog.length, 10);
      assert.ok(catalog.some(item => item.id === 'faceplant'));
      return suggestion;
    },
    mediaApi: {
      async extractEvidence({ inputPath, duration, hasAudio }) {
        assert.deepEqual(await readFile(inputPath), video);
        assert.equal(duration, 180);
        assert.equal(hasAudio, true);
        return evidence;
      },
      async renderVideo({ plan, media, assets, outputPath }) {
        assert.deepEqual(media, mediaInfo);
        assert.match(assets.get('faceplant').path, /faceplant\.png$/);
        rendered.push(plan);
        await writeFile(outputPath, renderBytes);
      },
    },
  });
  const status = await expectJson(await request('/api/status'), 200);
  assert.equal(status.ai, true);
  const project = await importVideo(request);
  const { plan } = await expectJson(await request(project + '/analyze', { method: 'POST' }), 200);
  assert.deepEqual(plan, { ...suggestion, outputDuration: 180 });

  const editedPlan = {
    segments: [{ start: 40, end: 120 }, { start: 5, end: 20 }],
    edits: [{ ...edits[0], caption: 'Dat ging mis', mode: 'cutaway' }],
  };
  const first = await expectJson(await request(project + '/render', jsonRequest(editedPlan)), 201);
  const second = await expectJson(await request(project + '/render', jsonRequest(editedPlan)), 201);
  assert.equal(first.duration, 95);
  assert.equal(second.duration, 95);
  assert.notEqual(first.download, second.download);
  assert.deepEqual(rendered[0], {
    segments: [{ start: 5, end: 20 }, { start: 40, end: 120 }],
    edits: editedPlan.edits,
    outputDuration: 95,
  });
  assert.deepEqual(rendered[1], rendered[0]);

  const download = await request(first.download);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.match(download.headers.get('content-disposition'), /attachment.+\.mp4/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), renderBytes);
  assert.equal((await request(project, { method: 'DELETE' })).status, 204);
  await expectJson(await request(first.download), 404, 'project_missing');
});

test('keeps manual rendering available when the AI key is absent', async t => {
  const request = await startServer(t, {
    analyze() { assert.fail('Analysis requires an API key'); },
  });
  const status = await expectJson(await request('/api/status'), 200);
  assert.equal(status.ai, false);
  const project = await importVideo(request);
  await expectJson(await request(project + '/analyze', { method: 'POST' }), 503, 'ai_unavailable');
  const rendered = await expectJson(await request(project + '/render', jsonRequest(gameplayPlan)), 201);
  assert.equal(rendered.duration, 180);
});

test('rejects invalid uploads before creating a project', async t => {
  const request = await startServer(t, {
    mediaApi: {
      async probeVideo(inputPath) {
        const content = await readFile(inputPath, 'utf8');
        if (content === 'short') return { ...mediaInfo, duration: 30 };
        if (content === 'missing executable') throw Object.assign(new Error('Cannot spawn'), { code: 'ENOENT' });
        throw new Error('Unsupported video');
      },
    },
  });
  const path = '/api/projects';
  await expectJson(await request(path, { method: 'POST', body: 'text upload' }), 415, 'upload_type');
  await expectJson(await request(path, binaryRequest(Buffer.alloc(0))), 400, 'empty_body');
  await expectJson(await request(path, binaryRequest('corrupt')), 422, 'invalid_video');
  await expectJson(await request(path, binaryRequest('short')), 422, 'duration');
  await expectJson(await request(path, binaryRequest('missing executable')), 503, 'missing_ffmpeg');
});

test('rejects foreign origins, malformed JSON, and unknown assets without rendering', async t => {
  const request = await startServer(t, {
    mediaApi: { async renderVideo() { assert.fail('The server must reject this plan before rendering'); } },
  });
  await expectJson(await request('/api/status', { headers: { Origin: 'https://foreign.example' } }), 403, 'origin');
  const project = await importVideo(request);
  const render = project + '/render';
  await expectJson(await request(render, { method: 'POST', body: 'wrong MIME type' }), 415, 'plan_type');
  await expectJson(await request(render, { ...jsonRequest({}), body: '{' }), 400, 'invalid_json');
  const plan = {
    ...gameplayPlan,
    edits: [{ time: 10, duration: 1, memeId: 'outside-library', caption: '', zoom: 1,
      mode: 'overlay', sound: false, reason: '' }],
  };
  await expectJson(await request(render, jsonRequest(plan)), 422, 'invalid_plan');
});

test('blocks a second render or deletion while a render is running', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let renderCalls = 0;
  const request = await startServer(t, {
    mediaApi: {
      async renderVideo({ outputPath }) {
        renderCalls += 1;
        if (renderCalls === 1) {
          started.resolve();
          await finish.promise;
        }
        await writeFile(outputPath, renderBytes);
      },
    },
  });
  const project = await importVideo(request);
  const first = request(project + '/render', jsonRequest(gameplayPlan));
  try {
    await Promise.race([started.promise, first.then(response => {
      assert.fail('First render finished before it reached the renderer: ' + response.status);
    })]);
    await expectJson(await request(project + '/render', jsonRequest(gameplayPlan)), 409, 'busy');
    await expectJson(await request(project, { method: 'DELETE' }), 409, 'busy');
  } finally {
    finish.resolve();
  }
  await expectJson(await first, 201);
});
