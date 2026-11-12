(() => {
  const drawings = {
    logo: '<circle cx="6" cy="7" r="2.8"/><circle cx="6" cy="17" r="2.8"/><path d="m8.2 8.8 11.3 10.7M8.2 15.2l7.4-7"/><path d="M19 2v6m-3-3h6"/>',
    folder: '<path d="M3.5 6.5h6l2 2H20a1 1 0 0 1 1 1v8.75A1.75 1.75 0 0 1 19.25 20H4.75A1.75 1.75 0 0 1 3 18.25V7a.5.5 0 0 1 .5-.5Z"/><path d="M3 11.5h18"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'arrow-left': '<path d="M20 12H4m7-7-7 7 7 7"/>',
    'arrow-up-right': '<path d="M6 18 18 6M8 6h10v10"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    clapperboard: '<path d="M3.5 11h17v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-8Zm0 0-1-4 16.8-4.5 1 4L3.5 11Zm4-5.3L10 9m3-4.8 2.5 3.3M7.5 15.5h9"/>',
    library: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.2"/>',
    'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m-3-11h.25m-.25 4h.25"/>',
    sparkles: '<path d="M10 3c.7 4.5 2.5 6.3 7 7-4.5.7-6.3 2.5-7 7-.7-4.5-2.5-6.3-7-7 4.5-.7 6.3-2.5 7-7Zm8.5 10v7m-3.5-3.5h7m-4-14V7m-2.25-2.25h4.5"/>',
    play: '<path d="M8 4.75 20 12 8 19.25V4.75Z"/>',
    pause: '<path d="M9 5H6v14h3V5Zm9 0h-3v14h3V5Z"/>',
    'skip-back': '<path d="M5 5v14m14-14L8 12l11 7V5Z"/>',
    'skip-forward': '<path d="M19 5v14M5 5l11 7-11 7V5Z"/>',
    volume: '<path d="M3.5 9H7l5-4v14l-5-4H3.5V9Zm12-1a5.7 5.7 0 0 1 0 8m2.7-11a9.9 9.9 0 0 1 0 14"/>',
    'volume-x': '<path d="M3.5 9H7l5-4v14l-5-4H3.5V9ZM16 9.5l5 5m0-5-5 5"/>',
    maximize: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 4v16m9-16v16M3 9h4.5m9 0H21M3 15h4.5m9 0H21"/>',
    waveform: '<path d="M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4"/>',
    image: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><circle cx="9" cy="9" r="1.4"/><path d="m4 17 4-4 2.5 2.5 4.5-5 5.5 5.5"/>',
    type: '<path d="M4 8V5h16v3M12 5v14m-3 0h6"/>',
    'zoom-in': '<circle cx="10" cy="10" r="5.75"/><path d="m14.2 14.2 5.5 5.5M7.5 10h5M10 7.5v5"/>',
    'zoom-out': '<circle cx="10" cy="10" r="5.75"/><path d="m14.2 14.2 5.5 5.5M7.5 10h5"/>',
    scissors: '<circle cx="6" cy="7" r="2.75"/><circle cx="6" cy="17" r="2.75"/><path d="m8 9 12 11M8 15 20 4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 1.75"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    eye: '<path d="M2.5 12s3.5-5.75 9.5-5.75S21.5 12 21.5 12s-3.5 5.75-9.5 5.75S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    'eye-off': '<path d="M3.5 3.5l17 17m-4-3.9a10 10 0 0 1-4.5 1.15C6 17.75 2.5 12 2.5 12a17 17 0 0 1 3.4-3.6m3-1.65c1-.35 2-.5 3.1-.5 6 0 9.5 5.75 9.5 5.75a15 15 0 0 1-2.4 2.85"/>',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    sliders: '<path d="M3 6h8m4 0h6M3 12h3m4 0h11M3 18h12m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11.5v4.75m0-8.5v.05"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12.5" rx="1.75"/><path d="M12 17v3.5m-4 0h8"/>',
    link: '<path d="m10 14 4-4m-5.8 6.8-1 1a3 3 0 0 1-4.2-4.2l4-4a3 3 0 0 1 4.2 0m4.6-2.4 1-1a3 3 0 0 1 4.2 4.2l-4 4a3 3 0 0 1-4.2 0"/>',
    'circle-help': '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.3a2.55 2.55 0 0 1 5.05.5c0 1.55-2.55 1.9-2.55 3.5m0 3.1v.05"/>',
    'rotate-ccw': '<path d="M4 5v5h5M4.5 9a7.75 7.75 0 1 1 .7 7.5"/>',
    'chevrons-right': '<path d="m5 7 5 5-5 5m8-10 5 5-5 5"/>',
  };

  function icon(name, size = 18) {
    if (!Object.hasOwn(drawings, name)) return '';
    const numericSize = Number(size);
    const dimension = Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 18;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawings[name]}</svg>`;
  }

  function renderIcons() {
    for (const element of document.querySelectorAll('[data-icon]')) {
      element.innerHTML = icon(element.dataset.icon, element.dataset.size);
    }
  }

  window.icon = icon;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderIcons, { once: true });
  } else {
    renderIcons();
  }
})();
