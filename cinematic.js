(() => {
  'use strict';

  const track = document.getElementById('scroll-track');
  const video = document.getElementById('background-video');
  const canvasA = document.getElementById('frame-canvas');
  const canvasB = document.getElementById('frame-canvas-alt');
  const sceneFallback = document.getElementById('scene-fallback');
  const navbar = document.getElementById('navbar');
  const menu = document.getElementById('mobile-menu');
  const openButton = document.getElementById('menu-open');
  const menuLabel = document.getElementById('menu-label');
  const closeButton = document.getElementById('menu-close');
  const sections = Array.from(document.querySelectorAll('.text-section'));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const LERP_TAU = 8;
  const SNAP = 0.002;
  const LRU_MAX = 24;
  const LEAD = 24;
  const WATCHDOG = 60000;
  const PRELOAD_AHEAD = 6;
  const PRELOAD_BEHIND = 2;
  const CROSSFADE_MS = 280;

  let span = Math.max(1, track.offsetHeight - window.innerHeight);
  let duration = 0;
  let current = 0;
  let target = 0;
  let previousTime = 0;
  let bank = [];
  let cache = new Map();
  let loadingFrames = new Map();
  let failedFrames = new Set();
  let ready = false;
  let reverted = false;
  let painted = false;
  let building = false;
  let displayIndex = -1;
  let lastPreloadIndex = -1;
  let decoding = null;
  let pendingImages = 0;
  let disposed = false;
  let aborter = null;
  let imageFallback = false;
  let frontCanvas = canvasA;
  let backCanvas = canvasB;
  let crossfadeTimer = null;

  const ctxA = canvasA.getContext('2d', { alpha: false });
  const ctxB = canvasB.getContext('2d', { alpha: false });

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const getProgress = () => clamp(window.scrollY / span, 0, 1);
  const recalculate = () => {
    span = Math.max(1, track.offsetHeight - window.innerHeight);
  };
  window.addEventListener('resize', recalculate);
  window.addEventListener('orientationchange', recalculate);

  const network = navigator.connection;
  const preferLightPath =
    (network && (network.saveData || /(?:^| )(2g|slow-2g)(?:$| )/.test(network.effectiveType || ''))) ||
    false;

  if (preferLightPath && video) {
    video.preload = 'none';
  }

  function sectionOpacity(index, progress) {
    if (index === 0) return progress < 0.2 ? 1 : Math.max(0, 1 - (progress - 0.2) / 0.08);
    if (index === 1) {
      if (progress < 0.32) return 0;
      if (progress < 0.4) return (progress - 0.32) / 0.08;
      if (progress < 0.55) return 1;
      return Math.max(0, 1 - (progress - 0.55) / 0.08);
    }
    if (progress < 0.67) return 0;
    if (progress < 0.75) return (progress - 0.67) / 0.08;
    return 1;
  }

  function updateText(progress) {
    navbar.classList.toggle('is-light', progress > 0.55);
    sections.forEach((section, index) => {
      const opacity = sectionOpacity(index, progress);
      section.style.opacity = opacity;
      section.classList.toggle('visible', opacity > 0.3);
      section.style.pointerEvents = opacity > 0.3 ? 'auto' : 'none';
      section.setAttribute('aria-hidden', opacity > 0.3 ? 'false' : 'true');
      section.querySelectorAll('.stagger').forEach(child => {
        child.style.setProperty('--delay', `${child.dataset.delay || 0}ms`);
      });
    });
  }

  function nearestIndex(microseconds) {
    if (!bank.length) return 0;
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

  function sectionAnchorIndices() {
    if (!bank.length) return [];
    return [
      0,
      Math.min(bank.length - 1, Math.round(bank.length * 0.45)),
      bank.length - 1,
    ];
  }

  function schedulePreload(progress) {
    if (!bank.length) return;
    const index = nearestIndex(progress * duration * 1e6);
    if (index === lastPreloadIndex) return;
    lastPreloadIndex = index;

    for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset += 1) {
      void warmImage(index + offset);
    }

    sectionAnchorIndices().forEach(anchor => void warmImage(anchor));
  }

  async function warmImage(index) {
    if (index < 0 || index >= bank.length) return;
    const cached = cache.get(index);
    if (cached) return;
    if (loadingFrames.has(index)) return loadingFrames.get(index);
    if (failedFrames.has(index)) return;

    const job = (async () => {
      if (!cache.has(index)) cache.set(index, null);

      try {
        let source = bank[index].blob;
        if (!source) {
          const response = await fetch(bank[index].url);
          if (!response.ok) throw new Error('Frame unavailable');
          source = await response.blob();
          bank[index].blob = source;
        }
        const bitmap = await createImageBitmap(source);
        if (reverted || disposed || !cache.has(index)) {
          bitmap.close();
          return;
        }
        const previous = cache.get(index);
        if (previous) previous.close();
        cache.set(index, bitmap);
        while (cache.size > LRU_MAX) {
          const oldest = cache.keys().next().value;
          cache.get(oldest)?.close();
          cache.delete(oldest);
        }
      } catch (_) {
        failedFrames.add(index);
        cache.delete(index);
      } finally {
        loadingFrames.delete(index);
      }
    })();

    loadingFrames.set(index, job);
    return job;
  }

  function setFallbackVisible(show) {
    if (sceneFallback) sceneFallback.style.opacity = show ? '1' : '0';
  }

  function swapCanvases() {
    const hiding = frontCanvas;
    if (reducedMotion.matches) {
      hiding.classList.remove('is-visible', 'live');
      return;
    }
    if (crossfadeTimer) clearTimeout(crossfadeTimer);
    crossfadeTimer = setTimeout(() => {
      hiding.classList.remove('is-visible', 'live');
      crossfadeTimer = null;
    }, CROSSFADE_MS);
  }

  function drawNearest() {
    if (!bank.length) return;
    const index = nearestIndex(current * 1e6);
    const bitmap = cache.get(index);

    schedulePreload(getProgress());

    if (!bitmap) {
      if (!painted) setFallbackVisible(true);
      return;
    }

    if (index === displayIndex) return;

    const inactive = frontCanvas === canvasA ? canvasB : canvasA;
    const inactiveCtx = frontCanvas === canvasA ? ctxB : ctxA;
    inactiveCtx.drawImage(bitmap, 0, 0, canvasA.width, canvasA.height);

    inactive.classList.add('is-visible', 'live');
    swapCanvases();
    backCanvas = frontCanvas;
    frontCanvas = inactive;

    displayIndex = index;
    painted = true;
    setFallbackVisible(false);
    canvasA.classList.add('live');
    canvasB.classList.add('live');
  }

  function revert() {
    reverted = true;
    ready = false;
    building = false;
    canvasA.classList.remove('live', 'is-visible');
    canvasB.classList.remove('live', 'is-visible');
    if (aborter) aborter.abort();
    if (decoding && decoding.state !== 'closed') decoding.close();
    cache.forEach(bitmap => bitmap?.close());
    cache.clear();
    loadingFrames.clear();
    bank = [];
    displayIndex = -1;
    lastPreloadIndex = -1;
    if (video.error || video.readyState === 0) useImageFallback();
  }

  function useImageFallback() {
    if (imageFallback || disposed) return;
    imageFallback = true;
    bank = Array.from({ length: 80 }, (_, index) => ({
      ts: (index + 0.5) * 125000,
      url:
        index === 0
          ? './frames/opening.webp'
          : `./frames/frame-${String(index + 1).padStart(3, '0')}.webp`,
      blob: null,
    }));
    duration = 10.041667;
    ready = true;
    reverted = false;
    displayIndex = -1;
    painted = false;
    setFallbackVisible(true);
    void warmImage(0).then(() => drawNearest());
    void warmImage(1);
    void warmImage(sectionAnchorIndices()[1]);
    void warmImage(bank.length - 1);
  }

  video.addEventListener('error', () => {
    if (video.error) useImageFallback();
  });

  if (!video.canPlayType('video/mp4; codecs="avc1.640028"')) {
    useImageFallback();
  }

  function tick(timestamp) {
    const delta = previousTime ? Math.min(0.1, (timestamp - previousTime) / 1000) : 0;
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

      if (ready && !reverted) {
        drawNearest();
      } else if (
        !imageFallback &&
        !video.seeking &&
        Math.abs(video.currentTime - current) > 0.01
      ) {
        try {
          video.currentTime = clamp(current, 0, Math.max(0, duration - 0.001));
        } catch (_) {
          /* wait for video metadata */
        }
      }
    }

    requestAnimationFrame(tick);
  }

  video.addEventListener('loadedmetadata', () => {
    duration = video.duration || duration;
  });
  if (video.readyState >= 1) duration = video.duration || 0;
  requestAnimationFrame(tick);

  function avcDescription(config) {
    if (!config) return undefined;
    const bytes = [
      config.configurationVersion,
      config.AVCProfileIndication,
      config.profile_compatibility,
      config.AVCLevelIndication,
      0xfc | config.lengthSizeMinusOne,
      0xe0 | config.SPS.length,
    ];
    for (const item of config.SPS) {
      bytes.push(item.length >> 8, item.length & 255, ...Array.from(item));
    }
    bytes.push(config.PPS.length);
    for (const item of config.PPS) {
      bytes.push(item.length >> 8, item.length & 255, ...Array.from(item));
    }
    return new Uint8Array(bytes);
  }

  async function buildBank(software = false) {
    if (
      building ||
      reverted ||
      imageFallback ||
      preferLightPath ||
      reducedMotion.matches ||
      !window.VideoDecoder ||
      !window.MP4Box
    ) {
      return;
    }
    building = true;
    aborter = new AbortController();
    const watchdog = setTimeout(revert, WATCHDOG);
    let parser;
    let scratch;
    let scratchContext;
    let samples = [];
    let trackInfo;
    let finished = false;
    const encoding = new Set();
    try {
      const response = await fetch(video.currentSrc || video.src, {
        signal: aborter.signal,
      });
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
      parser.onSamples = (_id, _user, batch) => {
        samples.push(...batch);
      };
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
      scratch.width = canvasA.width;
      scratch.height = canvasA.height;
      scratchContext = scratch.getContext('2d', { alpha: false });
      if (!scratchContext) throw new Error('Canvas unsupported');
      let decodeError = null;
      decoding = new VideoDecoder({
        output(frame) {
          if (reverted) {
            frame.close();
            return;
          }
          const ts = frame.timestamp;
          scratchContext.drawImage(frame, 0, 0, scratch.width, scratch.height);
          frame.close();
          pendingImages++;
          const job = new Promise((resolve, reject) => {
            scratch.toBlob(
              blob => (blob ? resolve(blob) : reject(new Error('Frame encoding failed'))),
              'image/webp',
              0.82
            );
          })
            .then(blob => {
              if (!reverted) {
                bank.push({ ts, blob });
                ready = true;
              }
            })
            .catch(() => {
              /* video fallback remains available */
            })
            .finally(() => {
              pendingImages--;
              encoding.delete(job);
            });
          encoding.add(job);
        },
        error(error) {
          decodeError = error;
        },
      });
      decoding.configure(support.config);
      for (const sample of samples) {
        if (reverted || decodeError) throw decodeError || new Error('Extraction stopped');
        while (decoding.decodeQueueSize + pendingImages >= LEAD) {
          await new Promise(resolve => setTimeout(resolve, 12));
          if (reverted || decodeError) throw decodeError || new Error('Extraction stopped');
        }
        decoding.decode(
          new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
            duration: Math.round((sample.duration / sample.timescale) * 1e6),
            data: sample.data,
          })
        );
      }
      await decoding.flush();
      await Promise.allSettled([...encoding]);
      if (decodeError || !bank.length) throw decodeError || new Error('No decoded frames');
      bank.sort((a, b) => a.ts - b.ts);
      ready = true;
      finished = true;
      void warmImage(nearestIndex(getProgress() * duration * 1e6));
      schedulePreload(getProgress());
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

  function scheduleBuildBank() {
    if (reducedMotion.matches || preferLightPath) return;
    const start = () => {
      if (!imageFallback) void buildBank();
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(start, { timeout: 2500 });
    } else {
      setTimeout(start, 600);
    }
  }

  window.addEventListener('load', scheduleBuildBank, { once: true });

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
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.classList.contains('open')) setMenu(false);
  });
  document.querySelectorAll('a[href^="#"]').forEach(link =>
    link.addEventListener('click', event => {
      const progressById = { '#top': 0, '#partnerships': 0.45, '#future': 0.82 };
      const destination = progressById[link.getAttribute('href')];
      if (destination === undefined) return;
      event.preventDefault();
      if (menu.classList.contains('open')) setMenu(false);
      window.scrollTo({
        top: span * destination,
        behavior: reducedMotion.matches ? 'instant' : 'smooth',
      });
    })
  );
})();