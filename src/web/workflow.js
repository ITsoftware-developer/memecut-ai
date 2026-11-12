(() => {
  'use strict';

  const presets = Object.freeze([
    { id: 'dramatic', title: 'Dramatic hit', emoji: '💀', color: '#ff9462', tags: ['fail', 'schrik', 'lava'], caption: 'BROOO 💀', zoom: 1.22, description: 'Een korte dreun en snelle zoom voor een onverwachte fail.' },
    { id: 'victory', title: 'Clutch', emoji: '🏆', color: '#c3ff60', tags: ['winst', 'clutch'], caption: 'CLUTCH!', zoom: 1.16, description: 'Een stijgende fanfare voor een overwinning op het nippertje.' },
    { id: 'fail', title: 'Skill issue', emoji: '🎯', color: '#e997ff', tags: ['misser', 'fail'], caption: 'SKILL ISSUE', zoom: 1.18, description: 'Een dalende toon voor een schot dat had moeten raken.' },
    { id: 'laugh', title: 'Laugh track', emoji: '😂', color: '#69ddfa', tags: ['lachen', 'reactie'], caption: 'IK GA STUK 😂', zoom: 1.1, description: 'Een ritmisch geluid en een lichte zoom bij een lachbui.' },
    { id: 'awkward', title: 'Facepalm', emoji: '🤦', color: '#ffcf65', tags: ['facepalm', 'stilte'], caption: '… serieus?', zoom: 1.12, description: 'Twee droge tonen bij een pijnlijke vergissing.' },
  ].map(preset => Object.freeze({ ...preset, tags: Object.freeze(preset.tags), sound: preset.id })));

  function getPreset(id) {
    return presets.find(preset => preset.id === id);
  }

  function makeMoment(id, time, title, reason, presetId, duration = 1.8) {
    const { caption, zoom, sound } = getPreset(presetId);
    return { id, time, title, reason, presetId, duration, caption, zoom, sound, enabled: true };
  }

  const demo = Object.freeze({
    duration: 312,
    currentTime: 12.8,
    selectedId: 'lava',
    moments: Object.freeze([
      makeMoment('lava', 12.8, 'Lavafail', 'Je valt in lava en roept direct “NEEEE!”. De korte dreun valt op je stemreactie.', 'dramatic', 2),
      makeMoment('shot', 43.4, 'Schot gemist', 'Je mist een makkelijk schot. De dalende toon accentueert het moment dat de pijl langs het doel gaat.', 'fail'),
      makeMoment('laugh', 97.2, 'Iedereen lacht', 'Je team barst in lachen uit. De lichte zoom legt de nadruk op de gezamenlijke reactie.', 'laugh'),
      makeMoment('clutch', 188.7, 'Clutch op het nippertje', 'Je overleeft met je laatste hartje. De fanfare begint zodra je veilig bent.', 'victory', 2.2),
    ].map(Object.freeze)),
  });

  function getActiveMoment(moments, time) {
    return moments.reduce((active, moment) => {
      const inRange = time >= moment.time && time < moment.time + moment.duration;
      return moment.enabled && inRange && (!active || moment.time >= active.time) ? moment : active;
    }, null);
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function getEffectFrame(moment, time) {
    if (!moment) return { zoom: 1, pop: 1, opacity: 0 };

    const elapsed = time - moment.time;
    const remaining = moment.duration - elapsed;
    const enter = clamp(elapsed / 0.16, 0, 1);
    const exit = clamp(remaining / 0.26, 0, 1);
    const zoom = 1 + ((Number(moment.zoom) || 1) - 1) * (1 - (1 - enter) ** 3) * exit;
    const pop = 1 - 0.22 * Math.exp(-Math.max(0, elapsed) * 13) * Math.cos(elapsed * 26);

    return { zoom, pop, opacity: clamp(elapsed / 0.045, 0, 1) * exit };
  }

  function tone(context, destination, { start, duration, from, to = from, type = 'sine', level = 0.16 }) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = start + duration;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, end);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(destination);
    oscillator.start(start);
    oscillator.stop(end);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
  }

  const soundNotes = {
    dramatic: [{ duration: 0.55, from: 108, to: 32, level: 0.31 }, { duration: 0.11, from: 160, to: 49, type: 'triangle', level: 0.2 }],
    victory: [{ duration: 0.19, from: 523, type: 'triangle' }, { offset: 0.11, duration: 0.2, from: 659, type: 'triangle' }, { offset: 0.22, duration: 0.38, from: 784, type: 'triangle' }],
    fail: [{ duration: 0.45, from: 452, to: 138, type: 'triangle', level: 0.23 }],
    laugh: [{ duration: 0.17, from: 414, to: 268, type: 'triangle' }, { offset: 0.13, duration: 0.17, from: 385, to: 242, type: 'triangle' }, { offset: 0.25, duration: 0.2, from: 346, to: 193, type: 'triangle' }],
    awkward: [{ duration: 0.17, from: 313, level: 0.17 }, { offset: 0.3, duration: 0.24, from: 211, level: 0.17 }],
  };

  function playSound(context, sound, destination = context.destination, delay = 0) {
    if (!Object.hasOwn(soundNotes, sound)) return;

    const start = context.currentTime + Math.max(0.015, delay);
    for (const note of soundNotes[sound]) {
      tone(context, destination, { ...note, start: start + (note.offset || 0) });
    }
  }

  function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(fraction * (sorted.length - 1))] ?? 0;
  }

  function audioPeaks(audio, duration) {
    const interval = 0.15;
    const windowSize = Math.round(audio.sampleRate * interval);
    const count = Math.floor(Math.min(duration, audio.duration) / interval);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    const energies = Array.from({ length: count }, (_, index) => {
      let power = 0;
      let samples = 0;
      const start = index * windowSize;
      const end = Math.min(start + windowSize, audio.length);

      for (const channel of channels) {
        for (let position = start; position < end; position += 4) {
          power += channel[position] ** 2;
          samples += 1;
        }
      }

      return samples ? Math.sqrt(power / samples) : 0;
    });

    const baseline = percentile(energies, 0.5);
    const threshold = Math.max(0.03, baseline * 1.7, percentile(energies, 0.9) * 0.95);
    const candidates = [];

    for (let index = 1; index < energies.length - 1; index += 1) {
      const energy = energies[index];
      const leadIn = percentile(energies.slice(Math.max(0, index - 8), index), 0.5);
      if (energy < threshold || energy < energies[index - 1] || energy < energies[index + 1]) continue;
      if (energy < leadIn * 1.5 || energy - leadIn < 0.018) continue;
      candidates.push({ time: index * interval, score: energy - leadIn });
    }

    candidates.sort((a, b) => b.score - a.score);
    const chosen = [];
    const spacing = Math.min(16, Math.max(3, duration / 15));
    const limit = clamp(Math.ceil(duration / 60), 1, 8);

    for (const candidate of candidates) {
      if (chosen.some(existing => Math.abs(existing.time - candidate.time) < spacing)) continue;
      chosen.push(candidate);
      if (chosen.length === limit) break;
    }

    return chosen.sort((a, b) => a.time - b.time).map(({ time }, index) => ({
      ...makeMoment(`audio-${index + 1}`, time, 'Audiopiek', 'Het volume stijgt hier plotseling. Luister terug om te horen wat er gebeurt.', 'dramatic'),
      duration: Math.min(1.8, duration - time),
      caption: '',
      zoom: 1.12,
      sound: null,
    }));
  }

  async function analyzeVideo(file, duration, { signal } = {}) {
    signal?.throwIfAborted();
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext || file.size > 256 * 1024 * 1024) {
      return { status: 'unsupported', moments: [], message: 'Deze video kan niet lokaal op audiopieken worden geanalyseerd. Je kunt momenten toevoegen op de tijdlijn.' };
    }

    try {
      const context = new OfflineContext(1, 1, 16000);
      const data = await file.arrayBuffer();
      signal?.throwIfAborted();
      const audio = await context.decodeAudioData(data);
      signal?.throwIfAborted();
      const moments = audioPeaks(audio, Number.isFinite(duration) ? duration : audio.duration);

      return moments.length
        ? { status: 'detected', moments, message: `${moments.length} ${moments.length === 1 ? 'audiopiek gevonden' : 'audiopieken gevonden'}.` }
        : { status: 'quiet', moments: [], message: 'Geen duidelijke audiopieken gevonden. Je kunt momenten toevoegen op de tijdlijn.' };
    } catch {
      signal?.throwIfAborted();
      return { status: 'unsupported', moments: [], message: 'De browser kon de audiotrack niet uitlezen. Je kunt momenten toevoegen op de tijdlijn.' };
    }
  }

  const exportFormats = [
    { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4' },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm', label: 'WebM' },
    { mimeType: 'video/webm', extension: 'webm', label: 'WebM' },
  ];

  function supportedFormats() {
    if (!window.MediaRecorder?.isTypeSupported || !window.HTMLCanvasElement?.prototype.captureStream || !window.AudioContext) return [];
    return exportFormats.filter(format => MediaRecorder.isTypeSupported(format.mimeType));
  }

  function getExportFormat() {
    return supportedFormats()[0] ?? null;
  }

  function drawFrame(canvas, context, video, moment) {
    const { width, height } = canvas;
    const { zoom, pop, opacity } = getEffectFrame(moment, video.currentTime);
    const marginX = width * (1 - zoom) / 2;
    const marginY = height * (1 - zoom) / 2;
    context.drawImage(video, marginX, marginY, width * zoom, height * zoom);

    if (!moment?.caption) return;

    const fontSize = Math.round(Math.min(width / 11, height / 7) * pop);
    context.save();
    context.globalAlpha = opacity;
    context.font = `900 ${fontSize}px Impact, Arial Black, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(3, fontSize * 0.13);
    context.strokeStyle = '#0b0a0e';
    context.fillStyle = '#fff';
    context.strokeText(moment.caption, width / 2, height * 0.77, width * 0.9);
    context.fillText(moment.caption, width / 2, height * 0.77, width * 0.9);
    context.restore();
  }

  function firstFrame(video, source, signal) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        video.removeEventListener('loadeddata', onLoad);
        video.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      }

      function onLoad() {
        cleanup();
        resolve();
      }

      function onError() {
        cleanup();
        reject(new Error('De video kon niet worden geopend voor export.'));
      }

      function onAbort() {
        cleanup();
        reject(signal.reason);
      }

      video.addEventListener('loadeddata', onLoad, { once: true });
      video.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      video.src = source;
    });
  }

  function makeRecorder(stream, formats) {
    for (const format of formats) {
      try {
        const recorder = new MediaRecorder(stream, {
          mimeType: format.mimeType,
          videoBitsPerSecond: 5_000_000,
          audioBitsPerSecond: 128_000,
        });
        recorder.start(1000);
        return { recorder, format };
      } catch {
        // A browser may report support before the encoder is available at runtime.
      }
    }

    throw new Error('De browser kon geen video-encoder starten.');
  }

  function recordPlayback({ video, recorder, format, renderFrame, duration, onProgress, signal }) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let timer;

      function cleanup() {
        clearInterval(timer);
        video.pause();
        video.removeEventListener('ended', stop);
        video.removeEventListener('error', fail);
        signal?.removeEventListener('abort', abort);
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
      }

      function stop() {
        clearInterval(timer);
        if (recorder.state !== 'inactive') recorder.stop();
      }

      function fail() {
        stop();
        cleanup();
        reject(new Error('De video kon niet worden opgenomen tijdens de export.'));
      }

      function abort() {
        stop();
        cleanup();
        reject(signal.reason);
      }

      function tick() {
        try {
          renderFrame();
          if (video.currentTime >= duration) stop();
          onProgress?.(clamp(video.currentTime / duration, 0, 1));
        } catch {
          fail();
        }
      }

      recorder.ondataavailable = ({ data }) => {
        if (data.size) chunks.push(data);
      };
      recorder.onerror = fail;
      recorder.onstop = () => {
        cleanup();
        if (!chunks.length) {
          reject(new Error('De browser leverde geen videobestand op.'));
          return;
        }

        onProgress?.(1);
        resolve({ ...format, blob: new Blob(chunks, { type: recorder.mimeType || format.mimeType }) });
      };
      video.addEventListener('ended', stop, { once: true });
      video.addEventListener('error', fail, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setInterval(tick, 1000 / 30);
      video.play().catch(fail);
    });
  }

  async function renderVideo({ source, duration, moments, onProgress, signal }) {
    signal?.throwIfAborted();
    const formats = supportedFormats();
    if (!formats.length) throw new Error('Video-export is niet beschikbaar in deze browser.');
    if (!source) throw new Error('Voeg een gameplayvideo toe om een video te exporteren.');

    const audio = new AudioContext();
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    let output;

    try {
      await Promise.all([audio.resume(), firstFrame(video, source, signal)]);
      signal?.throwIfAborted();
      const end = Math.min(Number.isFinite(duration) ? duration : Infinity, video.duration);
      if (!Number.isFinite(end) || end <= 0 || !video.videoWidth || !video.videoHeight) {
        throw new Error('Deze video heeft geen afspeelbare beelden.');
      }

      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
      canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2);
      canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2);
      const context = canvas.getContext('2d', { alpha: false });
      const audioOutput = audio.createMediaStreamDestination();
      const compressor = audio.createDynamicsCompressor();
      const gameplayVolume = audio.createGain();
      gameplayVolume.gain.value = 0.88;
      audio.createMediaElementSource(video).connect(gameplayVolume).connect(compressor).connect(audioOutput);

      const sounds = moments.filter(moment => moment.enabled && moment.sound).sort((a, b) => a.time - b.time);
      let nextSound = 0;
      let lastProgress = -Infinity;
      function renderFrame() {
        const time = video.currentTime;
        drawFrame(canvas, context, video, getActiveMoment(moments, time));
        while (nextSound < sounds.length && sounds[nextSound].time <= time) {
          playSound(audio, sounds[nextSound].sound, compressor);
          nextSound += 1;
        }
      }

      drawFrame(canvas, context, video, getActiveMoment(moments, 0));
      output = canvas.captureStream(30);
      for (const track of audioOutput.stream.getAudioTracks()) output.addTrack(track);
      const { recorder, format } = makeRecorder(output, formats);

      return await recordPlayback({ video, recorder, format, renderFrame, duration: end, signal, onProgress: progress => {
        const now = performance.now();
        if (progress < 1 && now - lastProgress < 250) return;
        lastProgress = now;
        onProgress?.(progress);
      } });
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
      output?.getTracks().forEach(track => track.stop());
      await audio.close();
    }
  }

  window.MemeWorkflow = Object.freeze({
    demo,
    presets,
    getPreset,
    getActiveMoment,
    getEffectFrame,
    playSound,
    analyzeVideo,
    getExportFormat,
    renderVideo,
  });
})();
