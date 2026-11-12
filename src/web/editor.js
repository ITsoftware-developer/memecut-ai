(() => {
  'use strict';

  const workflow = window.MemeWorkflow;
  const $ = id => document.getElementById(id);
  const video = $('player-video');
  const ruler = $('timeline-ruler');
  const timeline = $('timeline-content');
  const demoName = 'minecraft-lava-run.mp4';
  const demoMemes = { lava: 'faceplant', shot: 'facepalm', laugh: 'laugh', clutch: 'victory' };
  const demoDescription = 'Zo is de demo gemonteerd. Kies een moment om de edit te bekijken.';
  let server = { available: false, ai: false };
  let memeCatalog = new Map();
  let project;
  let playing = false;
  let muted = false;
  let original = false;
  let selectedId = null;
  let zoomIndex = 0;
  let current = 0;
  let previousTick = 0;
  let playbackStart = 0;
  let playbackTime = 0;
  let frameRequest = 0;
  let audioContext;
  let toastTimer;
  let importId = 0;
  let analysis;
  let rendering;
  let draft;
  let draftPreset;
  let emptyMessage = '';
  const zooms = [1, 2, 4, 8];
  const wholeSource = duration => [{ start: 0, end: duration }];
  const insideSegment = (moment, segments) => segments.some(segment =>
    moment.time >= segment.start - 1e-6 && moment.time + moment.duration <= segment.end + 1e-6);
  const memeUrl = item => './assets/memes/' + encodeURIComponent(item.file);

  async function api(path, options) {
    const response = await fetch(path, options);
    if (response.status === 204) return;
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { code: data.code });
    return data;
  }

  async function loadCapabilities() {
    if (!['http:', 'https:'].includes(location.protocol)) return;
    let entries;
    try {
      const status = await api('/api/status');
      if (status.version === '0.2') {
        server = { ...status, available: true };
        entries = status.catalog;
      }
    } catch {
      // A static build still supports local playback and the meme catalogue.
    }
    if (!entries) {
      try {
        const response = await fetch('./assets/memes/catalog.json');
        if (response.ok) entries = await response.json();
      } catch {
        // Leave the original effect presets available.
      }
    }
    if (Array.isArray(entries)) memeCatalog = new Map(entries.map(item => [item.id, item]));
    renderLibrary();
    if (project.demo) {
      project.moments = project.moments.map(moment => moment.edited ? moment : { ...moment, memeId: demoMemes[moment.id] });
      renderMoments();
      renderTimeline();
    }
    if (!analysis) updateDirector();
  }

  async function serverOperation(target, action, plan, signal) {
    if (target.file.size > server.maxUpload) throw new Error('Voor FFmpeg en AI mag de bronvideo maximaal 256 MiB groot zijn.');
    async function upload() {
      const result = await api('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: target.file, signal,
      });
      target.serverId = result.id;
      target.serverDuration = result.media.duration;
    }
    function run() {
      let body = plan;
      // Container and video stream metadata can differ by an audio frame.
      if (plan && target.duration > target.serverDuration && target.duration - target.serverDuration < .15) {
        body = {
          segments: plan.segments.map(segment => ({ ...segment, end: Math.min(segment.end, target.serverDuration) })),
          edits: plan.edits.map(edit => ({ ...edit, duration: Math.min(edit.duration, target.serverDuration - edit.time) })),
        };
      }
      return api('/api/projects/' + target.serverId + '/' + action, {
        method: 'POST', signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    }
    if (!target.serverId) await upload();
    try {
      return await run();
    } catch (error) {
      if (error.code !== 'project_missing') throw error;
      await upload();
      return run();
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function timestamp(time, precise = false) {
    const tenths = Math.floor(Math.max(0, time) * 10 + 0.00001);
    const minutes = Math.floor(tenths / 600);
    const seconds = Math.floor(tenths / 10) % 60;
    const pad = number => String(number).padStart(2, '0');
    return pad(minutes) + ':' + pad(seconds) + (precise ? '.' + tenths % 10 : '');
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  function setStatus(message) {
    $('project-status').replaceChildren(document.createElement('span'), message);
  }

  function selectedMoment() {
    return project.moments.find(moment => moment.id === selectedId);
  }

  function statusForProject() {
    if (project.demo) return 'Voorbeeld geladen';
    return project.moments.length ? 'Montageplan beschikbaar' : 'Gameplay geladen';
  }

  function stopPlayback() {
    playing = false;
    cancelAnimationFrame(frameRequest);
    video.pause();
    updatePlayButton();
  }

  function updatePlayButton() {
    const button = $('play-toggle');
    button.setAttribute('aria-label', playing ? 'Pauzeren' : 'Afspelen');
    button.innerHTML = window.icon(playing ? 'pause' : 'play', 18);
  }

  function unlockAudio() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    audioContext ||= new Audio();
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    return audioContext;
  }

  function playEffect(sound) {
    if (!sound) return;
    const context = unlockAudio();
    if (context) workflow.playSound(context, sound);
  }

  function followPlayhead() {
    const scroller = $('timeline-scroll');
    const pixel = current / project.duration * timeline.clientWidth;
    if (pixel < scroller.scrollLeft || pixel > scroller.scrollLeft + scroller.clientWidth - 8) {
      scroller.scrollLeft = pixel - scroller.clientWidth * .25;
    }
  }

  function paintPlayhead() {
    $('current-time').textContent = timestamp(current, true);
    $('playhead').style.left = Math.min(99.99, current / project.duration * 100) + '%';
    ruler.setAttribute('aria-valuenow', current.toFixed(1));
    ruler.setAttribute('aria-valuetext', timestamp(current, true));
    const moment = original ? null : workflow.getActiveMoment(project.moments, current);
    const isStill = moment && !playing;
    const effect = workflow.getEffectFrame(moment, isStill ? Math.max(moment.time + .17, current) : current);
    const screen = $('screen');
    screen.style.setProperty('--screen-zoom', effect.zoom);
    screen.style.setProperty('--caption-pop', effect.pop);
    const meme = memeCatalog.get(moment?.memeId);
    const overlay = $('meme-overlay');
    overlay.hidden = !meme;
    if (meme && overlay.getAttribute('src') !== memeUrl(meme)) overlay.src = memeUrl(meme);
    screen.dataset.cutaway = String(Boolean(meme && moment.mode === 'cutaway'));
    const caption = $('preview-caption');
    caption.textContent = moment?.caption ?? '';
    caption.hidden = !moment?.caption;
    caption.style.opacity = isStill ? 1 : effect.opacity;
  }

  function seek(time, { follow = true } = {}) {
    current = Math.min(project.duration, Math.max(0, time));
    previousTick = current;
    if (project.demo && playing) {
      playbackStart = performance.now();
      playbackTime = current;
    }
    if (!project.demo && video.readyState) video.currentTime = current;
    paintPlayhead();
    if (follow) followPlayhead();
  }

  function playbackTick(now) {
    if (!playing) return;
    current = Math.min(project.duration, project.demo ? playbackTime + (now - playbackStart) / 1000 : video.currentTime);
    if (!original && !project.segments.some(segment => current >= segment.start && current < segment.end)) {
      const next = project.segments.find(segment => segment.start > current);
      if (next) seek(next.start);
      else {
        seek(project.segments.at(-1).end);
        stopPlayback();
        return;
      }
    }
    if (!muted && !original) {
      for (const moment of project.moments) {
        if (moment.enabled && moment.time >= previousTick && moment.time < current) playEffect(moment.sound);
      }
    }
    previousTick = current;
    paintPlayhead();
    followPlayhead();
    if (current >= project.duration || video.ended) stopPlayback();
    else frameRequest = requestAnimationFrame(playbackTick);
  }

  async function togglePlayback() {
    if (playing) {
      stopPlayback();
      paintPlayhead();
      return;
    }
    if (original && current >= project.duration) seek(0);
    if (!original && !project.segments.some(segment => current >= segment.start && current < segment.end)) {
      seek((project.segments.find(segment => segment.start > current) ?? project.segments[0]).start);
    }
    if (!muted) unlockAudio();
    const startingProject = project;
    playing = true;
    updatePlayButton();
    if (!project.demo) {
      try {
        await video.play();
      } catch {
        if (project === startingProject && playing) {
          stopPlayback();
          showToast('Deze video kan niet worden afgespeeld.');
        }
        return;
      }
    }
    if (project !== startingProject || !playing) return;
    playbackStart = performance.now();
    playbackTime = current;
    previousTick = current;
    frameRequest = requestAnimationFrame(playbackTick);
  }

  function setPreviewMode(mode) {
    original = mode === 'original';
    $('edited-mode').setAttribute('aria-pressed', String(!original));
    $('original-mode').setAttribute('aria-pressed', String(original));
    paintPlayhead();
  }

  function renderMoments() {
    const list = $('moment-list');
    const count = project.moments.length;
    const active = selectedMoment();
    $('edit-reason').hidden = !active;
    $('edit-reason-text').textContent = active?.reason ?? '';
    $('moments-count').textContent = count + (count === 1 ? ' moment' : ' momenten');
    list.innerHTML = count ? project.moments.map(moment => {
      const preset = workflow.getPreset(moment.presetId);
      const meme = memeCatalog.get(moment.memeId);
      const selected = moment.id === selectedId;
      const detail = !moment.enabled ? 'Uitgeschakeld' : meme ? meme.title + (moment.mode === 'cutaway' ? ' · Beeldvullend' : ' · Overlay') : moment.caption ? preset.title + ' · ' + (moment.sound ? 'Zoom + SFX' : 'Zoom') : 'Volumestijging';
      const art = meme ? '<img src="' + memeUrl(meme) + '" alt="">' : preset.emoji;
      return '<div class="moment-card' + (selected ? ' selected' : '') + (moment.enabled ? '' : ' off') + '">' +
        '<button class="moment-main" data-jump="' + escapeHtml(moment.id) + '" aria-pressed="' + selected + '">' +
        '<span class="moment-emoji" style="--preset:' + preset.color + '" aria-hidden="true">' + art + '</span>' +
        '<span class="moment-info"><strong><span class="moment-name">' + escapeHtml(moment.title) + '</span><time>' + timestamp(moment.time, true) + '</time></strong>' +
        '<small>' + escapeHtml(detail) + '</small></span></button>' +
        '<button class="icon-button moment-config" data-edit="' + escapeHtml(moment.id) + '" aria-label="' + escapeHtml(moment.title) + ' aanpassen" title="Moment aanpassen">' + window.icon('sliders', 14) + '</button></div>';
    }).join('') : '<p class="empty-moments">' + escapeHtml(emptyMessage || 'Analyseer je gameplay of voeg een moment toe op de tijdlijn.') + '</p>';
  }

  const tracks = [
    { id: 'meme-track', icon: 'sparkles', colors: ['#4a3268', '#8060ab', '#eedcff'], label: moment => memeCatalog.get(moment.memeId)?.title ?? (moment.caption ? workflow.getPreset(moment.presetId).title : 'Audiopiek') },
    { id: 'text-track', icon: 'type', colors: ['#64304f', '#9b547e', '#ffd8ed'], label: moment => moment.caption },
    { id: 'sound-track', icon: 'waveform', colors: ['#264952', '#467687', '#d1f5ff'], label: moment => moment.sound ? 'SFX' : '' },
  ];

  function renderTimeline() {
    const zoom = zooms[zoomIndex];
    const visibleDuration = project.duration / zoom;
    const tickSize = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180].find(size => size >= visibleDuration / 9) ?? 180;
    const ticks = [];
    for (let time = 0; time < project.duration; time += tickSize) {
      if ((project.duration - time) / visibleDuration < .04) break;
      ticks.push('<span class="ruler-tick" style="left:' + time / project.duration * 100 + '%">' + timestamp(time) + '</span>');
    }
    ruler.innerHTML = ticks.join('');
    ruler.setAttribute('aria-valuemax', project.duration.toFixed(1));
    $('zoom-level').textContent = zoom + '×';
    $('timeline-zoom-out').disabled = zoomIndex === 0;
    $('timeline-zoom-in').disabled = zoomIndex === zooms.length - 1;
    timeline.style.width = zoom * 100 + '%';
    timeline.dataset.demo = String(project.demo);
    let startGap = 0;
    const gaps = [];
    for (const segment of [...project.segments, { start: project.duration, end: project.duration }]) {
      if (segment.start > startGap) gaps.push('<span class="cut-region" style="left:' + startGap / project.duration * 100 + '%;width:' + (segment.start - startGap) / project.duration * 100 + '%"></span>');
      startGap = segment.end;
    }
    $('cut-regions').innerHTML = gaps.join('');
    for (const track of tracks) {
      const [bg, border, text] = track.colors;
      $(track.id).innerHTML = project.moments.map(moment => {
        const label = track.label(moment);
        if (!label) return '';
        const start = moment.time / project.duration * 100;
        const width = Math.min(100 - start, moment.duration / project.duration * 100);
        return '<button class="clip' + (moment.id === selectedId ? ' selected' : '') + (moment.enabled ? '' : ' off') +
          '" style="left:' + start + '%;width:' + width + '%;--clip-bg:' + bg + ';--clip-border:' + border + ';--clip-text:' + text +
          '" data-jump="' + escapeHtml(moment.id) + '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
          window.icon(track.icon, 12) + '<span>' + escapeHtml(label) + '</span></button>';
      }).join('');
    }
    paintPlayhead();
  }

  function renderProject() {
    $('project-kind').textContent = project.demo ? 'Voorbeeldproject' : 'Eigen gameplay';
    $('project-title').textContent = project.title;
    $('project-filename').textContent = project.filename;
    $('project-duration').textContent = timestamp(project.duration);
    $('total-time').textContent = timestamp(project.duration);
    $('project-format').textContent = project.landscape ? 'YouTube · 16:9' : 'Bronformaat';
    $('gameplay-label').textContent = project.filename;
    $('demo-image').hidden = !project.demo;
    $('screen-tag').hidden = !project.demo;
    video.hidden = project.demo;
    updateDirector();
    setStatus(statusForProject());
    renderMoments();
    renderTimeline();
  }

  function updateDirector() {
    $('director-intro').textContent = project.demo ? demoDescription : server.ai
      ? 'De regisseur gebruikt transcript en geselecteerde frames. Bij analyse gaan audio en beelden naar OpenAI.'
      : 'Lokaal kun je audiopieken zoeken. Stel op de server een API-sleutel in voor de AI-regisseur.';
    $('analyze-label').textContent = project.demo ? 'Eigen gameplay analyseren' : server.ai ? 'AI-montage maken' : 'Audiopieken analyseren';
    $('analyze').disabled = false;
  }

  function loadProject(next, time, id) {
    stopPlayback();
    analysis?.abort();
    analysis = null;
    rendering?.abort();
    if (project?.serverId) void api('/api/projects/' + project.serverId, { method: 'DELETE' }).catch(() => {});
    if (project?.source) URL.revokeObjectURL(project.source);
    project = next;
    project.segments ??= wholeSource(next.duration);
    if (next.source) video.src = next.source;
    else video.removeAttribute('src');
    video.load();
    selectedId = id;
    zoomIndex = 0;
    emptyMessage = '';
    current = time;
    $('timeline-scroll').scrollLeft = 0;
    renderProject();
    setPreviewMode('edited');
  }

  function loadDemo() {
    const demo = workflow.demo;
    loadProject({
      demo: true, title: 'Minecraft, maar alles gaat mis', filename: demoName,
      duration: demo.duration, landscape: true, moments: demo.moments.map(moment => ({ ...moment, memeId: demoMemes[moment.id], mode: 'overlay' })),
    }, demo.currentTime, demo.selectedId);
  }

  function jumpTo(id) {
    const moment = project.moments.find(item => item.id === id);
    if (!moment) return;
    stopPlayback();
    selectedId = id;
    seek(moment.time);
    renderMoments();
    renderTimeline();
  }

  function stepMoment(direction) {
    const moments = project.moments;
    if (!moments.length) {
      seek(current + direction * 5);
      return;
    }
    const items = direction > 0 ? moments : [...moments].reverse();
    const next = items.find(moment => (moment.time - current) * direction > .12) ?? items[0];
    jumpTo(next.id);
  }

  function openImport() {
    $('import-status').textContent = '';
    $('file-input').value = '';
    $('import-dialog').showModal();
  }

  function readMetadata(source) {
    return new Promise((resolve, reject) => {
      const probe = document.createElement('video');
      const timeout = setTimeout(() => finish(new Error('Het lezen van de video duurde te lang.')), 12000);

      function finish(error) {
        clearTimeout(timeout);
        const metadata = { duration: probe.duration, width: probe.videoWidth, height: probe.videoHeight };
        probe.onloadedmetadata = probe.onerror = null;
        probe.removeAttribute('src');
        probe.load();
        if (error) reject(error);
        else resolve(metadata);
      }

      probe.preload = 'metadata';
      probe.onloadedmetadata = () => finish();
      probe.onerror = () => finish(new Error('Je browser kan dit videobestand niet openen.'));
      probe.src = source;
    });
  }

  async function importVideo(file) {
    if (!file) return;
    const attempt = ++importId;
    $('import-status').textContent = 'Video openen…';
    const source = URL.createObjectURL(file);
    try {
      const { duration, width, height } = await readMetadata(source);
      if (attempt !== importId || !$('import-dialog').open) {
        URL.revokeObjectURL(source);
        return;
      }
      if (!width || !height || !Number.isFinite(duration) || duration < 119.95 || duration > 600.05) {
        throw new Error('Kies een videobestand met een speelduur tussen 2 en 10 minuten.');
      }
      loadProject({
        demo: false, title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') || 'Eigen gameplay',
        filename: file.name, source, duration, landscape: Math.abs(width / height - 16 / 9) < .06, file, moments: [],
      }, 0, null);
      $('import-dialog').close();
    } catch (error) {
      URL.revokeObjectURL(source);
      if (attempt === importId) $('import-status').textContent = error.message;
    }
  }

  async function analyzeGameplay() {
    if (project.demo) {
      openImport();
      return;
    }
    if (analysis || rendering) return;
    const controller = new AbortController();
    const target = project;
    analysis = controller;
    $('analyze').disabled = true;
    $('analyze-label').textContent = server.ai ? 'AI-montage maken…' : 'Audio analyseren…';
    setStatus(server.ai ? 'Transcript en gameplaybeelden worden geanalyseerd' : 'Audio wordt lokaal geanalyseerd');
    try {
      if (server.ai) {
        const { plan } = await serverOperation(target, 'analyze', null, controller.signal);
        if (analysis !== controller) return;
        project.segments = plan.segments;
        project.moments = plan.edits.map((edit, index) => {
          const meme = memeCatalog.get(edit.memeId);
          const presetId = meme.tags.some(tag => tag === 'winst' || tag === 'succes') ? 'victory' :
            meme.tags.includes('lachen') ? 'laugh' : 'dramatic';
          return { ...edit, id: 'ai-' + (index + 1), title: meme.title, presetId, enabled: true, sound: edit.sound ? presetId : null };
        });
        emptyMessage = plan.edits.length ? 'AI-montage klaar · ' + timestamp(plan.outputDuration) : 'De AI vond geen geschikte meme. Je kunt zelf een moment toevoegen.';
      } else {
        const result = await workflow.analyzeVideo(project.file, project.duration, { signal: controller.signal });
        if (analysis !== controller) return;
        const keptMoments = project.moments.filter(moment => !moment.id.startsWith('audio-') || moment.edited);
        const candidates = result.moments.filter(moment => insideSegment(moment, project.segments) &&
          !keptMoments.some(kept => kept.id === moment.id || kept.enabled && momentsOverlap(moment, kept)));
        project.moments = [...keptMoments, ...candidates].sort((a, b) => a.time - b.time);
        emptyMessage = result.message;
      }
      if (project.moments.length) jumpTo(project.moments[0].id);
      else {
        selectedId = null;
        renderMoments();
        renderTimeline();
      }
      setStatus(emptyMessage);
    } catch (error) {
      if (analysis === controller) setStatus(server.ai ? error.message : 'De audioanalyse is mislukt. Voeg een moment toe of probeer opnieuw.');
    } finally {
      if (analysis === controller) {
        analysis = null;
        updateDirector();
      }
    }
  }

  function openMoment(moment) {
    stopPlayback();
    const defaultPreset = workflow.presets[0];
    const segment = project.segments.find(item => current >= item.start && current <= item.end - .2) ?? project.segments[0];
    const time = current >= segment.start && current <= segment.end - .2 ? current : segment.start;
    draft = moment ?? {
      id: null, time, duration: Math.max(.2, Math.min(2, segment.end - time)),
      title: 'Eigen moment', reason: 'Handmatig toegevoegd.', presetId: defaultPreset.id,
      caption: defaultPreset.caption, zoom: defaultPreset.zoom, sound: defaultPreset.sound, enabled: true,
    };
    draftPreset = draft.presetId;
    $('moment-title').textContent = moment?.title ?? 'Moment toevoegen';
    $('moment-description').textContent = draft.reason;
    $('preset-select').value = draft.presetId;
    $('meme-select').value = memeCatalog.has(draft.memeId) ? draft.memeId : '';
    $('meme-mode').value = draft.mode || 'overlay';
    $('meme-mode').disabled = !$('meme-select').value;
    $('caption-input').value = draft.caption;
    $('moment-start').value = draft.time;
    $('moment-start').max = project.duration - .2;
    $('moment-duration').value = draft.duration;
    $('sound-enabled').checked = Boolean(draft.sound);
    $('moment-enabled').checked = draft.enabled;
    $('moment-status').textContent = '';
    $('moment-dialog').showModal();
  }

  function momentsOverlap(a, b) {
    return a.time < b.time + b.duration - 1e-6 && b.time < a.time + a.duration - 1e-6;
  }

  function saveMoment(event) {
    event.preventDefault();
    const start = $('moment-start').valueAsNumber;
    const duration = $('moment-duration').valueAsNumber;
    if (start + duration > project.duration + .0001) {
      $('moment-status').textContent = 'Het moment eindigt na het einde van de video.';
      return;
    }
    const preset = workflow.getPreset($('preset-select').value);
    const memeId = $('meme-select').value || null;
    const item = {
      ...draft, id: draft.id || 'manual-' + Date.now(), time: start, duration, presetId: preset.id,
      memeId, mode: memeId ? $('meme-mode').value : 'overlay',
      caption: $('caption-input').value.trim(), zoom: preset.id === draft.presetId ? draft.zoom : preset.zoom,
      sound: $('sound-enabled').checked ? preset.sound : null, enabled: $('moment-enabled').checked, edited: true,
    };
    const others = project.moments.filter(moment => moment.id !== item.id);
    if (item.enabled && (!insideSegment(item, project.segments) || others.some(moment => moment.enabled && momentsOverlap(moment, item)))) {
      $('moment-status').textContent = 'Plaats het moment binnen één bewaard fragment, zonder overlap met een andere edit.';
      return;
    }
    project.moments = [...others, item].sort((a, b) => a.time - b.time);
    $('moment-dialog').close();
    jumpTo(item.id);
    setStatus('Montageplan bijgewerkt');
    showToast('Moment opgeslagen');
  }

  function renderLibrary() {
    $('preset-select').innerHTML = workflow.presets.map(preset =>
      '<option value="' + preset.id + '">' + preset.title + '</option>').join('');
    const memes = [...memeCatalog.values()];
    const currentMeme = $('meme-select').value;
    $('meme-select').innerHTML = '<option value="">Geen</option>' + memes.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title) + '</option>').join('');
    if (memeCatalog.has(currentMeme)) $('meme-select').value = currentMeme;
    $('library-list').innerHTML = memes.length ? memes.map(item =>
      '<div class="library-item"><img src="' + memeUrl(item) + '" alt=""><span><strong>' + escapeHtml(item.title) +
      '</strong><small>' + escapeHtml(item.description) + '</small></span></div>').join('') :
      '<p class="empty-moments">Open de editor via de lokale server om de afbeeldingen te laden.</p>';
  }

  function setSegmentRows(segments) {
    $('segment-list').innerHTML = segments.map((segment, index) => '<div class="segment-row"><label>Begin (s)' +
      '<input type="number" class="segment-start" min="0" step="any" required value="' + segment.start + '"></label><label>Einde (s)' +
      '<input type="number" class="segment-end" min="0" step="any" required value="' + segment.end + '"></label>' +
      '<button type="button" class="icon-button" data-remove-segment aria-label="Fragment ' + (index + 1) + ' verwijderen"' +
      (segments.length === 1 ? ' disabled' : '') + '>' + window.icon('x', 16) + '</button></div>').join('');
    $('split-cut').disabled = segments.length >= 6;
  }

  function readSegmentRows() {
    return [...$('segment-list').querySelectorAll('.segment-row')].map(row => ({
      start: row.querySelector('.segment-start').valueAsNumber,
      end: row.querySelector('.segment-end').valueAsNumber,
    }));
  }

  function saveCuts(event) {
    event.preventDefault();
    const segments = readSegmentRows().sort((a, b) => a.start - b.start);
    if (segments.some((item, index) => !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start < 0 || item.end > project.duration || item.end - item.start < .5 - 1e-6 ||
        (index && item.start < segments[index - 1].end))) {
      $('cuts-status').textContent = 'Gebruik fragmenten van minstens een halve seconde, zonder overlap en binnen de bronduur.';
      return;
    }
    if (project.moments.some(moment => moment.enabled && !insideSegment(moment, segments))) {
      $('cuts-status').textContent = 'Een edit valt in een cut. Verplaats of deactiveer die edit eerst.';
      return;
    }
    project.segments = segments;
    $('cuts-dialog').close();
    renderTimeline();
    setStatus('Cuts opgeslagen · montage ' + timestamp(outputDuration()));
  }

  function outputDuration() {
    return project.segments.reduce((total, segment) => total + segment.end - segment.start, 0);
  }

  function download(blob, name) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  function fileStem() {
    return project.filename.replace(/\.[^.]+$/, '') || 'memecut';
  }

  function openExport() {
    const format = workflow.getExportFormat();
    const needsServer = project.moments.some(moment => moment.enabled && memeCatalog.has(moment.memeId)) ||
      outputDuration() < project.duration - 1e-6;
    let description = 'Deze browser kan het videobeeld niet opnemen. Je kunt het montageplan downloaden.';
    if (project.demo) description = 'Download het montageplan van de demo. Importeer een eigen videobestand om een video te renderen.';
    else if (server.available) description = 'FFmpeg rendert de actieve edits en cuts als een MP4. Montageduur ' + timestamp(outputDuration()) + '.';
    else if (needsServer) description = 'Start de lokale FFmpeg-server om een montage met memeafbeeldingen of cuts te renderen.';
    else if (format) description = 'Render je video met tekst, zoom en geluidseffecten. De browser rendert in afspeelsnelheid. Houd dit tabblad open.';
    $('export-description').textContent = description;
    $('render-label').textContent = server.available ? 'MP4 renderen' : format ? format.label + ' renderen' : 'Video renderen';
    $('render-video').hidden = project.demo || (!server.available && (needsServer || !format));
    $('render-video').disabled = Boolean(analysis || rendering);
    $('download-mp4').hidden = true;
    $('cancel-render').hidden = true;
    $('export-progress').hidden = true;
    $('export-status').textContent = '';
    $('export-dialog').showModal();
  }

  function downloadPlan() {
    const plan = {
      version: 2, source: project.filename, sourceDuration: project.duration,
      ...exportPlan(),
      demo: project.demo, moments: project.moments.map(({ edited, ...moment }) => moment),
    };
    download(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }), fileStem() + '-montageplan.json');
    $('export-status').textContent = 'Montageplan aangeboden als download.';
  }

  function exportPlan() {
    return {
      segments: project.segments,
      edits: project.moments.filter(moment => moment.enabled).map(moment => {
        const memeId = memeCatalog.has(moment.memeId) ? moment.memeId : null;
        return {
          time: moment.time, duration: moment.duration, memeId, caption: moment.caption,
          mode: memeId ? moment.mode || 'overlay' : 'overlay', zoom: moment.zoom,
          sound: Boolean(moment.sound), reason: moment.reason,
        };
      }),
    };
  }

  async function renderVideo() {
    if (rendering || analysis || !project.source) return;
    stopPlayback();
    const target = project;
    const controller = new AbortController();
    rendering = controller;
    const progress = $('export-progress');
    progress.value = 0;
    progress.hidden = false;
    $('render-video').disabled = true;
    $('cancel-render').hidden = false;
    $('download-mp4').hidden = true;
    $('export-status').textContent = 'Render voorbereiden…';
    try {
      if (server.available) {
        progress.removeAttribute('value');
        $('export-status').textContent = 'FFmpeg rendert de montage…';
        const result = await serverOperation(target, 'render', exportPlan(), controller.signal);
        const link = $('download-mp4');
        link.href = result.download;
        link.download = fileStem() + '-memecut.mp4';
        link.hidden = false;
        $('export-status').textContent = 'MP4 klaar · ' + timestamp(result.duration);
        return;
      }
      const result = await workflow.renderVideo({
        source: project.source, duration: project.duration, moments: project.moments, signal: controller.signal,
        onProgress: fraction => {
          progress.value = fraction;
          $('export-status').textContent = 'Renderen · ' + Math.round(fraction * 100) + '%';
        },
      });
      download(result.blob, fileStem() + '-memecut.' + result.extension);
      $('export-status').textContent = result.label + ' aangeboden als download.';
    } catch (error) {
      $('export-status').textContent = controller.signal.aborted ? 'Render geannuleerd.' : error.message;
    } finally {
      rendering = null;
      $('render-video').disabled = false;
      $('cancel-render').hidden = true;
      progress.hidden = true;
    }
  }

  function setZoom(delta) {
    zoomIndex = Math.max(0, Math.min(zooms.length - 1, zoomIndex + delta));
    renderTimeline();
    followPlayhead();
  }

  function timelineSeek(event) {
    const bounds = timeline.getBoundingClientRect();
    seek((event.clientX - bounds.left) / bounds.width * project.duration, { follow: false });
  }

  $('open-import').addEventListener('click', openImport);
  $('open-demo').addEventListener('click', () => {
    if (!project.demo && !window.confirm('Het voorbeeld openen? Download eerst je montageplan als je het wilt bewaren.')) return;
    loadDemo();
  });
  $('nav-editor').addEventListener('click', () => $('project-title').scrollIntoView({ block: 'nearest' }));
  $('open-help').addEventListener('click', () => $('help-dialog').showModal());
  $('open-library').addEventListener('click', () => $('library-dialog').showModal());
  $('open-export').addEventListener('click', openExport);
  $('add-moment').addEventListener('click', () => openMoment(null));
  $('edit-cuts').addEventListener('click', () => {
    stopPlayback();
    setSegmentRows(project.segments);
    $('cuts-status').textContent = '';
    $('cuts-dialog').showModal();
  });
  $('reset-cuts').addEventListener('click', () => setSegmentRows(wholeSource(project.duration)));
  $('split-cut').addEventListener('click', () => {
    const segments = readSegmentRows();
    const currentIndex = segments.findIndex(segment => current - segment.start >= .5 && segment.end - current >= .5);
    const index = currentIndex >= 0 ? currentIndex : segments.findIndex(segment => segment.end - segment.start >= 1);
    if (index < 0) {
      $('cuts-status').textContent = 'Kies een fragment dat minstens één seconde lang is.';
      return;
    }
    const { start, end } = segments[index];
    const split = currentIndex >= 0 ? current : (start + end) / 2;
    segments.splice(index, 1, { start, end: split }, { start: split, end });
    setSegmentRows(segments);
    $('cuts-status').textContent = '';
  });
  $('segment-list').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-segment]');
    if (!button) return;
    const index = [...$('segment-list').children].indexOf(button.closest('.segment-row'));
    setSegmentRows(readSegmentRows().filter((_, position) => position !== index));
  });
  $('cuts-form').addEventListener('submit', saveCuts);
  $('analyze').addEventListener('click', analyzeGameplay);
  $('play-toggle').addEventListener('click', togglePlayback);
  $('previous-moment').addEventListener('click', () => stepMoment(-1));
  $('next-moment').addEventListener('click', () => stepMoment(1));
  $('edited-mode').addEventListener('click', () => setPreviewMode('edited'));
  $('original-mode').addEventListener('click', () => setPreviewMode('original'));
  $('timeline-zoom-out').addEventListener('click', () => setZoom(-1));
  $('timeline-zoom-in').addEventListener('click', () => setZoom(1));
  $('mute-toggle').addEventListener('click', () => {
    muted = !muted;
    video.muted = muted;
    $('mute-toggle').setAttribute('aria-pressed', String(muted));
    $('mute-toggle').setAttribute('aria-label', muted ? 'Geluid aanzetten' : 'Dempen');
    $('mute-toggle').innerHTML = window.icon(muted ? 'volume-x' : 'volume', 18);
  });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('player-stage').requestFullscreen();
    } catch {
      showToast('Volledig scherm is hier niet beschikbaar.');
    }
  });
  $('file-input').addEventListener('change', event => importVideo(event.target.files[0]));
  const dropzone = $('dropzone');
  dropzone.addEventListener('dragover', event => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', event => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    void importVideo(event.dataTransfer.files[0]);
  });
  $('preset-select').addEventListener('change', event => {
    if (event.target.value === draftPreset) return;
    const preset = workflow.getPreset(event.target.value);
    draftPreset = preset.id;
    $('caption-input').value = preset.caption;
    $('sound-enabled').checked = true;
  });
  $('meme-select').addEventListener('change', event => {
    $('meme-mode').disabled = !event.target.value;
  });
  $('moment-form').addEventListener('submit', saveMoment);
  $('download-plan').addEventListener('click', downloadPlan);
  $('render-video').addEventListener('click', renderVideo);
  $('cancel-render').addEventListener('click', () => rendering?.abort());
  $('export-dialog').addEventListener('close', () => rendering?.abort());
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }

  $('workspace').addEventListener('click', event => {
    const jump = event.target.closest('[data-jump]');
    const edit = event.target.closest('[data-edit]');
    if (jump) {
      const id = jump.dataset.jump;
      const fromTimeline = jump.classList.contains('clip');
      const track = jump.parentElement.id;
      jumpTo(id);
      const group = fromTimeline ? $(track) : $('moment-list');
      [...group.querySelectorAll('[data-jump]')].find(button => button.dataset.jump === id)?.focus({ preventScroll: true });
    }
    if (edit) {
      openMoment(project.moments.find(item => item.id === edit.dataset.edit));
    }
  });
  video.addEventListener('loadedmetadata', () => { if (!project.demo && current) video.currentTime = current; });
  ruler.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    ruler.setPointerCapture(event.pointerId);
    timelineSeek(event);
  });
  ruler.addEventListener('pointermove', event => {
    if (ruler.hasPointerCapture(event.pointerId)) timelineSeek(event);
  });
  $('gameplay-track').addEventListener('click', timelineSeek);
  document.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]') || event.target.closest('button, a, input, select, textarea')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) void togglePlayback();
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      seek(current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 5 : 1));
    }
  });
  renderLibrary();
  loadDemo();
  void loadCapabilities();
})();
