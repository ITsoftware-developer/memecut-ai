(() => {
  'use strict';

  const workflow = window.MemeWorkflow;
  const $ = id => document.getElementById(id);
  const video = $('player-video');
  const ruler = $('timeline-ruler');
  const timeline = $('timeline-content');
  const demoName = 'minecraft-lava-run.mp4';
  const demoDescription = 'Zo is de demo gemonteerd. Kies een moment om de edit te bekijken.';
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
    $('screen').style.setProperty('--screen-zoom', effect.zoom);
    $('screen').style.setProperty('--caption-pop', effect.pop);
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
    if (current >= project.duration) seek(0);
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
      const selected = moment.id === selectedId;
      const detail = !moment.enabled ? 'Uitgeschakeld' : moment.caption ? preset.title + ' · ' + (moment.sound ? 'Zoom + SFX' : 'Zoom') : 'Volumestijging';
      return '<div class="moment-card' + (selected ? ' selected' : '') + (moment.enabled ? '' : ' off') + '">' +
        '<button class="moment-main" data-jump="' + escapeHtml(moment.id) + '" aria-pressed="' + selected + '">' +
        '<span class="moment-emoji" style="--preset:' + preset.color + '" aria-hidden="true">' + preset.emoji + '</span>' +
        '<span class="moment-info"><strong><span class="moment-name">' + escapeHtml(moment.title) + '</span><time>' + timestamp(moment.time, true) + '</time></strong>' +
        '<small>' + escapeHtml(detail) + '</small></span></button>' +
        '<button class="icon-button moment-config" data-edit="' + escapeHtml(moment.id) + '" aria-label="' + escapeHtml(moment.title) + ' aanpassen" title="Moment aanpassen">' + window.icon('sliders', 14) + '</button></div>';
    }).join('') : '<p class="empty-moments">' + escapeHtml(emptyMessage || 'Analyseer je gameplay of voeg een moment toe op de tijdlijn.') + '</p>';
  }

  const tracks = [
    { id: 'meme-track', icon: 'sparkles', colors: ['#4a3268', '#8060ab', '#eedcff'], label: moment => moment.caption ? workflow.getPreset(moment.presetId).title : 'Audiopiek' },
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
    $('director-intro').textContent = project.demo ? demoDescription : 'Zoek op audiopieken en kies per moment een passende reactie.';
    $('analyze-label').textContent = project.demo ? 'Eigen gameplay analyseren' : 'Audiopieken analyseren';
    $('analyze').disabled = false;
    setStatus(statusForProject());
    renderMoments();
    renderTimeline();
  }

  function loadProject(next, time, id) {
    stopPlayback();
    analysis?.abort();
    analysis = null;
    if (project?.source) URL.revokeObjectURL(project.source);
    project = next;
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
      duration: demo.duration, landscape: true, moments: demo.moments.map(moment => ({ ...moment })),
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
      void analyzeGameplay();
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
    const controller = new AbortController();
    analysis = controller;
    $('analyze').disabled = true;
    $('analyze-label').textContent = 'Audio analyseren…';
    setStatus('Audio wordt lokaal geanalyseerd');
    try {
      const result = await workflow.analyzeVideo(project.file, project.duration, { signal: controller.signal });
      if (analysis !== controller) return;
      const keptMoments = project.moments.filter(moment => !moment.id.startsWith('audio-') || moment.edited);
      const occupied = new Set(keptMoments.map(moment => moment.id));
      const candidates = result.moments.filter(moment => !occupied.has(moment.id));
      project.moments = [...keptMoments, ...candidates].sort((a, b) => a.time - b.time);
      emptyMessage = result.message;
      if (project.moments.length) jumpTo(project.moments[0].id);
      else {
        selectedId = null;
        renderMoments();
        renderTimeline();
      }
      setStatus(result.message);
    } catch (error) {
      if (analysis === controller) setStatus('De audioanalyse is mislukt. Probeer het opnieuw of voeg een moment toe.');
    } finally {
      if (analysis === controller) {
        analysis = null;
        $('analyze').disabled = false;
        $('analyze-label').textContent = 'Audiopieken analyseren';
      }
    }
  }

  function openMoment(moment) {
    stopPlayback();
    const defaultPreset = workflow.presets[0];
    draft = moment ?? {
      id: null, time: Math.min(current, project.duration - .2), duration: Math.min(2, project.duration - current) || .2,
      title: 'Eigen moment', reason: 'Handmatig toegevoegd.', presetId: defaultPreset.id,
      caption: defaultPreset.caption, zoom: defaultPreset.zoom, sound: defaultPreset.sound, enabled: true,
    };
    draftPreset = draft.presetId;
    $('moment-title').textContent = moment?.title ?? 'Moment toevoegen';
    $('moment-description').textContent = draft.reason;
    $('preset-select').value = draft.presetId;
    $('caption-input').value = draft.caption;
    $('moment-start').value = Math.floor(draft.time * 10) / 10;
    $('moment-start').max = Math.floor((project.duration - .2) * 10) / 10;
    $('moment-duration').value = Math.max(.2, Math.floor(draft.duration * 10 + .00001) / 10);
    $('sound-enabled').checked = Boolean(draft.sound);
    $('moment-enabled').checked = draft.enabled;
    $('moment-status').textContent = '';
    $('moment-dialog').showModal();
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
    const item = {
      ...draft, id: draft.id || 'manual-' + Date.now(), time: start, duration, presetId: preset.id,
      caption: $('caption-input').value.trim(), zoom: preset.id === draft.presetId ? draft.zoom : preset.zoom,
      sound: $('sound-enabled').checked ? preset.sound : null, enabled: $('moment-enabled').checked, edited: true,
    };
    project.moments = [...project.moments.filter(moment => moment.id !== item.id), item].sort((a, b) => a.time - b.time);
    $('moment-dialog').close();
    jumpTo(item.id);
    setStatus('Montageplan bijgewerkt');
    showToast('Moment opgeslagen');
  }

  function renderLibrary() {
    $('preset-select').innerHTML = workflow.presets.map(preset =>
      '<option value="' + preset.id + '">' + preset.title + '</option>').join('');
    $('library-list').innerHTML = workflow.presets.map(preset => (
      '<div class="library-item"><span class="library-emoji" style="--preset:' + preset.color + '" aria-hidden="true">' + preset.emoji + '</span>' +
      '<span><strong>' + preset.title + '</strong><small>' + preset.tags.join(' · ') + '</small></span>' +
      '<button class="icon-button" data-sound="' + preset.sound + '" aria-label="' + preset.title + ' beluisteren" title="Geluid beluisteren">' +
      window.icon('volume', 16) + '</button></div>'
    )).join('');
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
    const description = project.demo
      ? 'Download het montageplan van de demo. Importeer een eigen videobestand om een video te renderen.'
      : format
        ? 'Render je video met de actieve tekst, zoom en geluidseffecten. De browser rendert in afspeelsnelheid. Houd dit tabblad open.'
        : 'Deze browser kan het videobeeld niet opnemen. Je kunt het montageplan downloaden.';
    $('export-description').textContent = description;
    $('render-label').textContent = format ? format.label + ' renderen' : 'Video renderen';
    $('render-video').hidden = project.demo || !format;
    $('render-video').disabled = false;
    $('cancel-render').hidden = true;
    $('export-progress').hidden = true;
    $('export-status').textContent = '';
    $('export-dialog').showModal();
  }

  function downloadPlan() {
    const plan = {
      version: 1, source: project.filename, sourceDuration: project.duration,
      demo: project.demo, moments: project.moments.map(({ edited, ...moment }) => moment),
    };
    download(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }), fileStem() + '-montageplan.json');
    $('export-status').textContent = 'Montageplan gedownload.';
  }

  async function renderVideo() {
    if (rendering || !project.source) return;
    stopPlayback();
    const controller = new AbortController();
    rendering = controller;
    const progress = $('export-progress');
    progress.value = 0;
    progress.hidden = false;
    $('render-video').disabled = true;
    $('cancel-render').hidden = false;
    $('export-status').textContent = 'Render voorbereiden…';
    try {
      const result = await workflow.renderVideo({
        source: project.source, duration: project.duration, moments: project.moments, signal: controller.signal,
        onProgress: fraction => {
          progress.value = fraction;
          $('export-status').textContent = 'Renderen · ' + Math.round(fraction * 100) + '%';
        },
      });
      download(result.blob, fileStem() + '-memecut.' + result.extension);
      $('export-status').textContent = result.label + ' gedownload.';
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
  $('library-list').addEventListener('click', event => {
    const button = event.target.closest('[data-sound]');
    if (button) playEffect(button.dataset.sound);
  });
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
})();
