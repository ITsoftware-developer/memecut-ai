import assert from 'node:assert/strict';
import test from 'node:test';
import { PlanError, validatePlan } from '../src/plan.mjs';

const rules = { duration: 180, memeIds: new Set(['faceplant', 'victory']) };
const wholeVideo = [{ start: 0, end: 180 }];

function edit(time, fields = {}) {
  return {
    time, duration: 1.5, memeId: 'faceplant', mode: 'overlay', sound: true,
    zoom: 1.2, caption: 'Bijna gelukt!', reason: 'Mislukte sprong', ...fields,
  };
}

function rejectsPlan(plan, message, options = rules) {
  assert.throws(() => validatePlan(plan, options), error => {
    assert.ok(error instanceof PlanError);
    assert.equal(error.statusCode, 422);
    assert.equal(error.code, 'invalid_plan');
    assert.match(error.message, message);
    return true;
  });
}

test('sorts source times, keeps cuts, and normalizes the same plan consistently', () => {
  const value = {
    segments: [{ start: 30, end: 70 }, { start: 0, end: 20 }],
    edits: [edit(47, { memeId: 'victory', caption: '  Win!\n ' }), edit(10)],
  };
  const original = structuredClone(value);
  const result = validatePlan(value, rules);

  assert.deepEqual(result, {
    segments: [{ start: 0, end: 20 }, { start: 30, end: 70 }],
    edits: [edit(10), edit(47, { memeId: 'victory', caption: 'Win!' })],
    outputDuration: 60,
  });
  assert.deepEqual(value, original);
  assert.deepEqual(validatePlan(result, rules), result);
});

test('accepts an edit ending exactly at the source end and rejects edits past it', () => {
  const lastEdit = edit(179.8, { duration: .2 });
  assert.deepEqual(validatePlan({ segments: wholeVideo, edits: [lastEdit] }, rules).edits, [lastEdit]);

  rejectsPlan({ segments: wholeVideo, edits: [edit(179.81, { duration: .2 })] }, /buiten een bewaard/);
  rejectsPlan({ segments: wholeVideo, edits: [edit(180.1)] }, /bereik/);
  rejectsPlan({ segments: [{ start: -1, end: 10 }], edits: [] }, /bereik/);
});

test('rejects overlapping cuts, overlapping edits, and edits in removed footage', () => {
  rejectsPlan({ segments: [{ start: 6, end: 12 }, { start: 0, end: 8 }], edits: [] }, /Gameplayfragmenten overlappen/);
  rejectsPlan({ segments: wholeVideo, edits: [edit(11), edit(10)] }, /Edits overlappen/);
  rejectsPlan({ segments: [{ start: 0, end: 10 }, { start: 15, end: 20 }], edits: [edit(9.9)] }, /buiten een bewaard/);
});

test('validates catalog membership and requires an image for a cutaway', () => {
  rejectsPlan({ segments: wholeVideo, edits: [edit(20, { memeId: 'unlisted' })] }, /onbekende meme/);
  rejectsPlan({ segments: wholeVideo, edits: [edit(20, { mode: 'cutaway', memeId: null })] }, /meme nodig/);

  const captionOnly = edit(20, { memeId: null });
  assert.deepEqual(validatePlan({ segments: wholeVideo, edits: [captionOnly] }, rules).edits, [captionOnly]);
});

test('caps automatic edits and prevents the AI plan from removing most footage', () => {
  const automatic = { ...rules, automatic: true };
  rejectsPlan({ segments: wholeVideo, edits: [edit(10), edit(20), edit(30), edit(40)] }, /maximaal 3/, automatic);
  rejectsPlan({ segments: [{ start: 30, end: 119 }], edits: [] }, /meer dan de helft/, automatic);
  rejectsPlan({ segments: wholeVideo, edits: [edit(20, { memeId: null })] }, /onbekende meme/, automatic);
  assert.equal(validatePlan({ segments: wholeVideo, edits: [] }, automatic).outputDuration, 180);
});
