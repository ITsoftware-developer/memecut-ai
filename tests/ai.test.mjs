import { strict as assert } from 'node:assert';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeGameplay } from '../src/ai.mjs';

async function fixture(t, withAudio = true) {
  const dir = await mkdtemp(join(tmpdir(), 'memecut-ai-'));
  const frame = join(dir, 'frame.jpg');
  const audioPath = withAudio ? join(dir, 'gameplay.m4a') : null;
  const files = audioPath ? [frame, audioPath] : [frame];
  t.after(async () => {
    await Promise.all(files.map(file => unlink(file)));
    await rmdir(dir);
  });
  await Promise.all(files.map(file => writeFile(file, 'mock media bytes')));
  return {
    evidence: { audioPath, frames: [{ time: 12.25, path: frame }] },
    duration: 180,
    catalog: [{ id: 'shock', title: 'Schrik', tags: ['verrassing'], description: 'Geschrokken reactie' }],
  };
}

function responsePlan(plan) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
  });
}

test('stuurt tijdgebonden spraak en beeld naar OpenAI en leest het strikte montageplan', async t => {
  const input = await fixture(t);
  const transcript = [{ start: 11.9, end: 12.4, text: 'Dat scheelde één hartje.' }];
  const plan = {
    segments: [{ start: 0, end: 160 }],
    edits: [{ time: 12.25, duration: 1.5, memeId: 'shock', caption: 'Één hartje!', zoom: 1.1, sound: true, mode: 'overlay', reason: 'De speler roept dat het één hartje scheelde.' }],
  };
  const calls = [];
  const result = await analyzeGameplay({
    ...input,
    config: {
      apiKey: 'test-api-key', visionModel: '', transcriptionModel: '',
      async fetch(url, options) {
        calls.push(url);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer test-api-key');
        assert.equal(options.redirect, 'error');
        if (url.endsWith('/audio/transcriptions')) {
          assert.ok(options.body instanceof FormData);
          assert.equal(options.body.get('model'), 'gpt-4o-transcribe-diarize');
          assert.equal(options.body.get('response_format'), 'diarized_json');
          assert.equal(options.body.get('chunking_strategy'), 'auto');
          assert.equal(options.body.get('file').name, 'audio.m4a');
          return Response.json({ segments: [{ ...transcript[0], speaker: 'A' }] });
        }
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-4.1-mini');
        assert.equal(body.store, false);
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.schema.properties.edits.maxItems, 3);
        assert.deepEqual(body.text.format.schema.properties.edits.items.properties.memeId.enum, ['shock']);
        const [context, time, image] = body.input[0].content;
        assert.deepEqual(JSON.parse(context.text).transcript, transcript);
        assert.match(time.text, /12\.250/);
        assert.match(image.image_url, /^data:image\/jpeg;base64,/);
        return responsePlan(plan);
      },
    },
  });
  assert.deepEqual(calls, ['https://api.openai.com/v1/audio/transcriptions', 'https://api.openai.com/v1/responses']);
  assert.deepEqual(result, { ...plan, transcript });
});

test('analyseert een stille video alleen op basis van frames en accepteert een leeg memeplan', async t => {
  const input = await fixture(t, false);
  const result = await analyzeGameplay({
    ...input,
    config: {
      apiKey: 'test-api-key',
      async fetch(url, { body }) {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.deepEqual(JSON.parse(JSON.parse(body).input[0].content[0].text).transcript, []);
        return responsePlan({ segments: [{ start: 0, end: 180 }], edits: [] });
      },
    },
  });
  assert.deepEqual(result, { segments: [{ start: 0, end: 180 }], edits: [], transcript: [] });
});

test('weigert een analyse zonder server-sleutel voor er een API-aanroep gebeurt', async () => {
  await assert.rejects(analyzeGameplay({
    config: { apiKey: '', fetch() { assert.fail('Onverwachte API-aanroep'); } },
  }), { code: 'ai_unconfigured', statusCode: 503 });
});

test('geeft een bruikbare limietfout zonder de providertekst door te geven', async t => {
  const input = await fixture(t, false);
  await assert.rejects(analyzeGameplay({
    ...input,
    config: {
      apiKey: 'test-api-key',
      async fetch() { return Response.json({ error: { message: 'privé providerinformatie' } }, { status: 429 }); },
    },
  }), error => error.code === 'ai_rate_limit' && error.statusCode === 429 && !error.message.includes('providerinformatie'));
});

test('behandelt een geweigerd modelantwoord als fout', async t => {
  const input = await fixture(t, false);
  await assert.rejects(analyzeGameplay({
    ...input,
    config: {
      apiKey: 'test-api-key',
      async fetch() {
        return Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Provider explanation' }] }],
        });
      },
    },
  }), { code: 'ai_refusal', statusCode: 502 });
});
