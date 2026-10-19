(() => {
  'use strict';

  const track = document.getElementById('scroll-track');
  const video = document.getElementById('background-video');
  const canvas = document.getElementById('frame-canvas');
  const navbar = document.getElementById('navbar');
  const menu = document.getElementById('mobile-menu');
  const openButton = document.getElementById('menu-open');
  const menuLabel = document.getElementById('menu-label');
  const closeButton = document.getElementById('menu-close');
  const sections = Array.from(document.querySelectorAll('.text-section'));
  const context = canvas.getContext('2d', { alpha: false });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const LERP_TAU = 8;
  const SNAP = 0.002;
  const LRU_MAX = 24;
  const LEAD = 24;
  const WATCHDOG = 60000;

  let span = Math.max(1, track.offsetHeight - window.innerHeight);
  let duration = 0;
  let current = 0;
  let target = 0;
  let previousTime = 0;
  let bank = [];
  let cache = new Map();
  let ready = false;
  let reverted = false;
  let painted = false;
  let building = false;
  let lastPainted = -1;
  let decoding = null;
  let pendingImages = 0;
  let disposed = false;
  let aborter = null;
  let imageFallback = false;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const getProgress = () => clamp(window.scrollY / span, 0, 1);
  const recalculate = () => { span = Math.max(1, track.offsetHeight - window.innerHeight); };
  window.addEventListener('resize', recalculate);
  window.addEventListener('orientationchange', recalculate);

  function sectionOpacity(index, progress) {
    if (index === 0) return progress < .20 ? 1 : Math.max(0, 1 - (progress - .20) / .08);
    if (index === 1) {
      if (progress < .32) return 0;
      if (progress < .40) return (progress - .32) / .08;
      if (progress < .55) return 1;
      return Math.max(0, 1 - (progress - .55) / .08);
    }
    if (progress < .67) return 0;
    if (progress < .75) return (progress - .67) / .08;
    return 1;
  }

  function updateText(progress) {
    navbar.classList.toggle('is-light', progress > .55);
    sections.forEach((section, index) => {
      const opacity = sectionOpacity(index, progress);
      section.style.opacity = opacity;
      section.classList.toggle('visible', opacity > .3);
      section.style.pointerEvents = opacity > .3 ? 'auto' : 'none';
      section.setAttribute('aria-hidden', opacity > .3 ? 'false' : 'true');
      section.querySelectorAll('.stagger').forEach(child => {
        child.style.setProperty('--delay', `${child.dataset.delay || 0}ms`);
      });
    });
  }

  function nearestIndex(microseconds) {
    let low = 0;
    let high = bank.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (bank[middle].ts < microseconds) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    if (low === bank.length) return bank.length - 1;
    return microseconds - bank[low - 1].ts <= bank[low].ts - microseconds ? low - 1 : low;
  }

  async function warmImage(index) {
    if (index < 0 || index >= bank.length || cache.has(index)) return;
    cache.set(index, null);
    try {
      const source = bank[index].blob || await fetch(bank[index].url).then(response => {
        if (!response.ok) throw new Error('Frame unavailable');
        return response.blob();
      });
      const bitmap = await createImageBitmap(source);
      if (reverted || disposed || !cache.has(index)) { bitmap.close(); return; }
      cache.set(index, bitmap);
      while (cache.size > LRU_MAX) {
        const oldest = cache.keys().next().value;
        cache.get(oldest)?.close();
        cache.delete(oldest);
      }
    } catch (_) { cache.delete(index); }
  }

  function drawNearest() {
    if (!bank.length || !context) return;
    const index = nearestIndex(current * 1e6);
    if (lastPainted === index && painted) return;
    for (let around = index - 1; around <= index + 2; around++) void warmImage(around);
    const bitmap = cache.get(index);
    if (!bitmap) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    lastPainted = index;
    if (!painted) {
      painted = true;
      canvas.classList.add('live');
    }
  }

  function revert() {
    reverted = true;
    ready = false;
    building = false;
    canvas.classList.remove('live');
    if (aborter) aborter.abort();
    if (decoding && decoding.state !== 'closed') decoding.close();
    cache.forEach(bitmap => bitmap?.close());
    cache.clear();
    bank = [];
    if (video.error || video.readyState === 0) useImageFallback();
  }

  // The same clip is pre-extracted for browsers that cannot decode its H.264 profile.
  function useImageFallback() {
    if (imageFallback || disposed) return;
    imageFallback = true;
    bank = Array.from({ length: 80 }, (_, index) => ({
      ts: (index + .5) * 125000,
      url: index === 0 ? './frames/opening.webp' : `./frames/frame-${String(index + 1).padStart(3, '0')}.webp`,
    }));
    duration = 10.041667;
    ready = true;
    reverted = false;
    lastPainted = -1;
    void warmImage(nearestIndex(getProgress() * duration * 1e6));
  }

  video.addEventListener('error', () => { if (video.error) useImageFallback(); });
  if (!video.canPlayType('video/mp4; codecs="avc1.640028"')) useImageFallback();

  function tick(timestamp) {
    const delta = previousTime ? Math.min(.1, (timestamp - previousTime) / 1000) : 0;
    previousTime = timestamp;
    const progress = getProgress();
    updateText(progress);
    if (duration > 0) {
      target = progress * duration;
      if (reducedMotion.matches) current = target;
      else {
        current += (target - current) * (1 - Math.exp(-delta * LERP_TAU));
        if (Math.abs(target - current) < SNAP) current = target;
      }
      if (ready && !reverted) drawNearest();
      else if (!video.seeking && Math.abs(video.currentTime - current) > .01) {
        try { video.currentTime = clamp(current, 0, Math.max(0, duration - .001)); } catch (_) { /* wait for video metadata */ }
      }
    }
    requestAnimationFrame(tick);
  }

  video.addEventListener('loadedmetadata', () => { duration = video.duration || duration; });
  if (video.readyState >= 1) duration = video.duration || 0;
  requestAnimationFrame(tick);

  // Construct the AVC decoder description from the MP4's avcC box, excluding its 8-byte box header.
  function avcDescription(config) {
    if (!config) return undefined;
    const bytes = [config.configurationVersion, config.AVCProfileIndication, config.profile_compatibility,
      config.AVCLevelIndication, 0xfc | config.lengthSizeMinusOne, 0xe0 | config.SPS.length];
    for (const item of config.SPS) bytes.push(item.length >> 8, item.length & 255, ...Array.from(item));
    bytes.push(config.PPS.length);
    for (const item of config.PPS) bytes.push(item.length >> 8, item.length & 255, ...Array.from(item));
    return new Uint8Array(bytes);
  }

  async function buildBank(software = false) {
    if (building || reverted || imageFallback || reducedMotion.matches || !window.VideoDecoder || !window.MP4Box) return;
    building = true;
    aborter = new AbortController();
    const watchdog = setTimeout(revert, WATCHDOG);
    let parser;
    let scratch;
    let scratchContext;
    let samples = [];
    let trackInfo;
    let finished = false;
    let encoding = new Set();
    try {
      const response = await fetch(video.currentSrc || video.src, { signal: aborter.signal });
      if (!response.ok) throw new Error('Video download unavailable');
      const buffer = await response.arrayBuffer();
      if (reverted) return;
      buffer.fileStart = 0;
      parser = MP4Box.createFile();
      parser.onReady = info => {
        trackInfo = info.videoTracks[0];
        if (!trackInfo) throw new Error('No video track');
        duration = trackInfo.duration / trackInfo.timescale;
        parser.setExtractionOptions(trackInfo.id, null, { nbSamples: 12 });
        parser.start();
      };
      parser.onSamples = (_id, _user, batch) => { samples.push(...batch); };
      parser.appendBuffer(buffer);
      parser.flush();
      if (!trackInfo || !samples.length) throw new Error('No video samples');
      const configBox = samples[0].description?.avcC;
      const config = {
        codec: trackInfo.codec,
        codedWidth: trackInfo.video.width,
        codedHeight: trackInfo.video.height,
        hardwareAcceleration: software ? 'prefer-software' : 'prefer-hardware',
        optimizeForLatency: true,
      };
      const description = avcDescription(configBox);
      if (description) config.description = description;
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) throw new Error('Codec unsupported');
      scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      scratchContext = scratch.getContext('2d', { alpha: false });
      if (!scratchContext) throw new Error('Canvas unsupported');
      let decodeError = null;
      decoding = new VideoDecoder({
        output(frame) {
          if (reverted) { frame.close(); return; }
          const ts = frame.timestamp;
          scratchContext.drawImage(frame, 0, 0, scratch.width, scratch.height);
          frame.close();
          pendingImages++;
          const job = new Promise((resolve, reject) => scratch.toBlob(blob => blob ? resolve(blob) : reject(new Error('Frame encoding failed')), 'image/webp', .82))
            .then(blob => { if (!reverted) { bank.push({ ts, blob }); ready = true; } })
            .catch(() => { /* video fallback remains available */ })
            .finally(() => { pendingImages--; encoding.delete(job); });
          encoding.add(job);
        },
        error(error) { decodeError = error; },
      });
      decoding.configure(support.config);
      for (const sample of samples) {
        if (reverted || decodeError) throw decodeError || new Error('Extraction stopped');
        while (decoding.decodeQueueSize + pendingImages >= LEAD) {
          await new Promise(resolve => setTimeout(resolve, 12));
          if (reverted || decodeError) throw decodeError || new Error('Extraction stopped');
        }
        decoding.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: Math.round(sample.cts / sample.timescale * 1e6),
          duration: Math.round(sample.duration / sample.timescale * 1e6),
          data: sample.data,
        }));
      }
      await decoding.flush();
      await Promise.allSettled([...encoding]);
      if (decodeError || !bank.length) throw decodeError || new Error('No decoded frames');
      bank.sort((a, b) => a.ts - b.ts);
      ready = true;
      finished = true;
    } catch (_) {
      if (!reverted && !software) {
        if (decoding && decoding.state !== 'closed') decoding.close();
        decoding = null;
        bank = [];
        ready = false;
        building = false;
        clearTimeout(watchdog);
        void buildBank(true);
        return;
      }
      revert();
      useImageFallback();
    } finally {
      clearTimeout(watchdog);
      if (finished) building = false;
    }
  }

  window.addEventListener('load', () => { if (!reducedMotion.matches) void buildBank(); }, { once: true });
  window.addEventListener('pagehide', () => {
    disposed = true;
    if (aborter) aborter.abort();
    cache.forEach(bitmap => bitmap?.close());
    if (decoding && decoding.state !== 'closed') decoding.close();
  });

  function setMenu(open) {
    menu.classList.toggle('open', open);
    menu.setAttribute('aria-hidden', String(!open));
    openButton.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) closeButton.focus();
    else openButton.focus();
  }
  openButton.addEventListener('click', () => setMenu(true));
  menuLabel.addEventListener('click', () => setMenu(true));
  closeButton.addEventListener('click', () => setMenu(false));
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.classList.contains('open')) setMenu(false); });
  document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', event => {
    const progressById = { '#top': 0, '#partnerships': .45, '#future': .82 };
    const destination = progressById[link.getAttribute('href')];
    if (destination === undefined) return;
    event.preventDefault();
    if (menu.classList.contains('open')) setMenu(false);
    window.scrollTo({ top: span * destination, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }));
})();
