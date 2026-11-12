export class PlanError extends Error {
  statusCode = 422;
  code = 'invalid_plan';
}

const tolerance = 1e-6;

function bounded(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min - tolerance || value > max + tolerance) {
    throw new PlanError(label + ' ligt buiten het toegestane bereik.');
  }
  return Math.max(min, Math.min(max, value));
}

function plainText(value, max, label) {
  if (typeof value !== 'string') throw new PlanError(label + ' moet tekst zijn.');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if ([...text].length > max) throw new PlanError(label + ' is te lang.');
  return text;
}

function validateOrder(items, start, end, label) {
  for (let index = 1; index < items.length; index += 1) {
    if (start(items[index]) < end(items[index - 1]) - tolerance) {
      throw new PlanError(label + ' overlappen.');
    }
  }
}

export function validatePlan(value, { duration, memeIds, automatic = false }) {
  if (!value || !Array.isArray(value.segments) || !Array.isArray(value.edits)) {
    throw new PlanError('Het plan moet fragmenten en edits bevatten.');
  }
  if (!value.segments.length || value.segments.length > 6 || value.edits.length > (automatic ? 3 : 30)) {
    throw new PlanError('Gebruik 1 tot 6 gameplayfragmenten en maximaal ' + (automatic ? 3 : 30) + ' edits.');
  }
  const segments = value.segments.map(item => {
    const start = bounded(item?.start, 0, duration, 'Begin van een gameplayfragment');
    const end = bounded(item?.end, 0, duration, 'Einde van een gameplayfragment');
    if (end - start < Math.min(.5, duration) - tolerance) {
      throw new PlanError('Een gameplayfragment moet minstens een halve seconde lang zijn.');
    }
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  validateOrder(segments, segment => segment.start, segment => segment.end, 'Gameplayfragmenten');

  const outputDuration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  if (automatic && outputDuration < duration / 2 - tolerance) {
    throw new PlanError('Het AI-plan zou meer dan de helft van de gameplay verwijderen.');
  }

  const edits = value.edits.map(item => {
    const time = bounded(item?.time, 0, duration, 'Start van een edit');
    const length = bounded(item?.duration, .2, 5, 'Duur van een edit');
    if (!segments.some(segment => time >= segment.start - tolerance && time + length <= segment.end + tolerance)) {
      throw new PlanError('Een edit valt geheel of gedeeltelijk buiten een bewaard gameplayfragment.');
    }
    const memeId = item.memeId ?? null;
    if ((memeId !== null || automatic) && !memeIds.has(memeId)) {
      throw new PlanError('Het plan verwijst naar een onbekende meme.');
    }
    if (!['overlay', 'cutaway'].includes(item.mode) || (item.mode === 'cutaway' && !memeId)) {
      throw new PlanError('Voor een beeldvullende onderbreking is een meme nodig.');
    }
    if (typeof item.sound !== 'boolean') throw new PlanError('Ongeldige instelling voor geluid.');
    return {
      time, duration: length, memeId, mode: item.mode, sound: item.sound,
      zoom: bounded(item.zoom, 1, 1.45, 'Zoom van een edit'),
      caption: plainText(item.caption, 60, 'Tekst van een edit'),
      reason: plainText(item.reason ?? '', 200, 'Toelichting van een edit'),
    };
  }).sort((a, b) => a.time - b.time);
  validateOrder(edits, edit => edit.time, edit => edit.time + edit.duration, 'Edits');
  return { segments, edits, outputDuration };
}
