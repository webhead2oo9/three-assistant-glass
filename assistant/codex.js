import { codexRequest } from './codex-api.js';

// The browser owns the media; our local server only bridges the Codex control
// protocol. OAuth tokens never enter the page or the app's settings JSON.
export function createCodexAssistant(settings, ui) {
  let running = false;
  let connected = false;
  let sessionId = null;
  let controller = null;
  let events = null;
  let peer = null;
  let mic = null;
  let audio = null;
  let audioCtx = null;
  let source = null;
  let analyser = null;
  let samples = null;
  let disconnectTimer = null;
  let speaking = false;
  let lastSound = 0;
  const transcripts = new Map();
  const onPageHide = () => stop();

  function milestone(label, run) {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const cancel = () => reject(run.signal.reason);
    const timer = setTimeout(() => reject(new Error(`Timed out ${label}. Try starting again.`)), 45000);
    run.signal.addEventListener('abort', cancel, { once: true });
    // A later milestone can fail before start() reaches its await.
    promise.catch(() => {}).finally(() => {
      clearTimeout(timer);
      run.signal.removeEventListener('abort', cancel);
    });
    return { promise, resolve, reject };
  }

  function fail(error) {
    if (!running) return;
    const wasConnected = connected;
    stop(error);
    if (wasConnected) ui.onEnd?.(error);
  }

  function stop(reason) {
    running = false;
    connected = false;
    controller?.abort(reason);
    clearTimeout(disconnectTimer);
    window.removeEventListener('pagehide', onPageHide);
    events?.close();
    peer?.close();
    mic?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    if (audio) { audio.pause(); audio.srcObject = null; }
    audioCtx?.close().catch(() => {});
    events = peer = mic = source = audio = audioCtx = analyser = null;
    samples = null;
    transcripts.clear();
    speaking = false;
    lastSound = 0;
    if (sessionId) {
      const id = sessionId;
      sessionId = null;
      void codexRequest(`/sessions/${id}/stop`, {}, { keepalive: true }).catch(() => {});
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      const run = new AbortController();
      controller = run;
      const active = () => running && controller === run && !run.signal.aborted;
      const ensureActive = () => run.signal.throwIfAborted();
      const failCurrent = error => { if (active()) fail(error); };
      window.addEventListener('pagehide', onPageHide);
      ui.onStatus('Connecting to ChatGPT…');
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
          throw new Error('Voice requires a browser with microphone and WebRTC support on localhost.');
        }
        audioCtx = new AudioContext();
        await audioCtx.resume();
        ensureActive();
        const auth = await codexRequest('/account', undefined, { signal: run.signal });
        ensureActive();
        if (auth.account?.type !== 'chatgpt') {
          throw new Error('Sign in with ChatGPT in Settings → Assistant first.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!active()) { stream.getTracks().forEach(track => track.stop()); ensureActive(); }
        mic = stream;
        // Let this allocation finish even on Stop so its returned ID can be
        // released. The server also expires allocations without an event stream.
        const allocated = await codexRequest('/sessions', {});
        if (!active()) {
          void codexRequest(`/sessions/${allocated.sessionId}/stop`, {}, { keepalive: true }).catch(() => {});
          ensureActive();
        }
        sessionId = allocated.sessionId;
        const ready = milestone('connecting to the local voice server', run);
        const answer = milestone('negotiating ChatGPT voice', run);
        const mediaConnected = milestone('connecting voice audio', run);
        events = new EventSource(`/api/codex/sessions/${sessionId}/events`);
        events.onerror = () => failCurrent(new Error('Voice connection was lost. Try starting again.'));
        events.onmessage = event => {
          if (!active()) return;
          let message;
          try { message = JSON.parse(event.data); }
          catch { failCurrent(new Error('Invalid voice event received.')); return; }
          switch (message.type) {
            case 'ready': ready.resolve(); break;
            case 'thread/realtime/sdp': answer.resolve(message.sdp); break;
            case 'error':
            case 'thread/realtime/error':
              failCurrent(new Error(message.message || 'ChatGPT voice is unavailable for this account.'));
              break;
            case 'thread/realtime/closed':
              failCurrent(connected ? undefined : new Error(message.reason || 'Voice session closed before connecting.'));
              break;
            case 'thread/realtime/transcript/delta':
            case 'thread/realtime/transcript/done': {
              if (!['user', 'assistant'].includes(message.role)) break;
              const done = message.type.endsWith('/done');
              const text = (done ? message.text : (transcripts.get(message.role) || '') + message.delta).slice(-12000);
              if (done) transcripts.delete(message.role);
              else transcripts.set(message.role, text);
              ui.onSpeaker(message.role === 'user' ? 'User' : 'Character');
              ui.onText(text);
              break;
            }
          }
        };
        await ready.promise;
        ensureActive();
        audio = document.createElement('audio');
        audio.autoplay = true;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        samples = new Uint8Array(analyser.fftSize);
        peer = new RTCPeerConnection();
        peer.ontrack = event => {
          if (!active() || event.track.kind !== 'audio') return;
          const remote = event.streams[0] || new MediaStream([event.track]);
          audio.srcObject = remote;
          source?.disconnect();
          source = audioCtx.createMediaStreamSource(remote);
          // The audio element plays the stream; the analyser only measures it.
          source.connect(analyser);
          audio.play().catch(() => failCurrent(new Error('Audio playback was blocked. Press Play to try again.')));
        };
        peer.onconnectionstatechange = () => {
          if (!active()) return;
          clearTimeout(disconnectTimer);
          if (peer.connectionState === 'connected') {
            mediaConnected.resolve();
          } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            failCurrent(new Error('Voice audio disconnected. Try starting again.'));
          } else if (peer.connectionState === 'disconnected') {
            disconnectTimer = setTimeout(() => failCurrent(new Error('Voice audio disconnected. Try starting again.')), 8000);
          }
        };
        for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
        peer.createDataChannel('oai-events');
        const offer = await peer.createOffer();
        ensureActive();
        await peer.setLocalDescription(offer);
        ensureActive();
        const [, sdp] = await Promise.all([
          codexRequest(`/sessions/${sessionId}/start`, { sdp: offer.sdp }, { signal: run.signal }),
          answer.promise,
        ]);
        ensureActive();
        await peer.setRemoteDescription({ type: 'answer', sdp });
        await mediaConnected.promise;
        ensureActive();
        connected = true;
        ui.onStatus('Listening…');
      } catch (error) {
        if (controller === run) stop();
        throw error;
      }
    },

    stop,

    addSystemMessage(text) {
      if (!connected || !sessionId || !text.trim()) return;
      const run = controller;
      void codexRequest(`/sessions/${sessionId}/context`, { text: text.slice(0, 8000) })
        .catch(error => { if (running && controller === run) ui.onError(error); });
    },

    mouthLevel() {
      if (!connected || !source || !analyser) return 0;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      if (level > 0.04) lastSound = performance.now();
      const talking = lastSound > 0 && performance.now() - lastSound < 250;
      if (talking !== speaking) {
        speaking = talking;
        ui.onStatus(talking ? 'Speaking…' : 'Listening…');
      }
      return level;
    },
  };
}
