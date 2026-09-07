import { codexRequest } from './codex-api.js';
import { createCodexTaskHandler } from './codex-tasks.js';

async function finishIceGathering(connection, signal) {
  if (connection.iceGatheringState === 'complete' || signal.aborted) return;
  await new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      connection.onicegatheringstatechange = null;
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    connection.onicegatheringstatechange = () => {
      if (connection.iceGatheringState === 'complete') done();
    };
    signal.addEventListener('abort', done, { once: true });
  });
}

// The browser owns the media; our local server only bridges the Codex control
// protocol. OAuth tokens never enter the page or the app's settings JSON.
export function createCodexAssistant(settings, ui) {
  let running = false;
  let connected = false;
  let established = false;
  let sessionId = null;
  let controller = null;
  let events = null;
  let peer = null;
  let dataChannel = null;
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
  let displayedRole = null;
  let tasks = null;
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
    const wasConnected = established;
    stop(error);
    if (wasConnected) ui.onEnd?.(error);
  }

  function stop(reason) {
    running = false;
    connected = false;
    established = false;
    controller?.abort(reason);
    clearTimeout(disconnectTimer);
    window.removeEventListener('pagehide', onPageHide);
    events?.close();
    tasks?.close(reason?.message);
    tasks = null;
    dataChannel?.close();
    dataChannel = null;
    peer?.close();
    mic?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    if (audio) { audio.pause(); audio.srcObject = null; }
    audioCtx?.close().catch(() => {});
    events = peer = mic = source = audio = audioCtx = analyser = null;
    samples = null;
    transcripts.clear();
    displayedRole = null;
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
      let answer = null, recovery = null, recoveryAttempts = 0;
      const recover = error => {
        if (!active() || recovery) return;
        if (!established || recoveryAttempts >= 2) { failCurrent(error); return; }
        recoveryAttempts++;
        connected = false;
        ui.onStatus('Reconnecting voice…');
        tasks?.handle({ type: 'codex/task/voiceStatus', message: 'Voice connection dropped. Reconnecting; your task is preserved.' });
        recovery = Promise.resolve().then(() => connectVoice('reconnect'))
          .then(() => { if (active()) tasks?.handle({ type: 'codex/task/voiceStatus', message: 'Voice reconnected.' }); })
          .catch(error => { if (active()) failCurrent(error); })
          .finally(() => { recovery = null; });
      };
      async function connectVoice(action) {
        ensureActive();
        const oldPeer = peer;
        peer = null;
        dataChannel?.close();
        dataChannel = null;
        oldPeer?.close();
        source?.disconnect();
        source = null;
        if (audio) { audio.pause(); audio.srcObject = null; }
        clearTimeout(disconnectTimer);
        transcripts.clear();
        displayedRole = null;
        answer = milestone('negotiating ChatGPT voice', run);
        const mediaConnected = milestone('connecting voice audio', run);
        audio = document.createElement('audio');
        audio.autoplay = true;
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        samples = new Uint8Array(analyser.fftSize);
        const connection = new RTCPeerConnection();
        peer = connection;
        connection.ontrack = event => {
          if (!active() || peer !== connection || event.track.kind !== 'audio') return;
          const remote = event.streams[0] || new MediaStream([event.track]);
          audio.srcObject = remote;
          source?.disconnect();
          source = audioCtx.createMediaStreamSource(remote);
          // The audio element plays the stream; the analyser only measures it.
          source.connect(analyser);
          audio.play().catch(() => failCurrent(new Error('Audio playback was blocked. Press Play to try again.')));
        };
        connection.onconnectionstatechange = () => {
          if (!active() || peer !== connection) return;
          clearTimeout(disconnectTimer);
          if (connection.connectionState === 'connected') {
            mediaConnected.resolve();
          } else if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
            recover(new Error('Voice audio disconnected.'));
          } else if (connection.connectionState === 'disconnected') {
            disconnectTimer = setTimeout(() => recover(new Error('Voice audio disconnected.')), 8000);
          }
        };
        for (const track of mic.getAudioTracks()) connection.addTrack(track, mic);
        // Keep the channel alive for the whole call. An unreferenced channel
        // without listeners can be garbage-collected and closed by the browser.
        // Transcripts still arrive through the app-server event stream.
        dataChannel = connection.createDataChannel('oai-events');
        dataChannel.onmessage = () => {};
        const offer = await connection.createOffer();
        ensureActive();
        await connection.setLocalDescription(offer);
        // The app-server exchange does not trickle ICE candidates afterward.
        // Send the gathered description, not the original candidate-free offer.
        await finishIceGathering(connection, run.signal);
        ensureActive();
        const [, sdp] = await Promise.all([
          codexRequest(`/sessions/${sessionId}/${action}`, { sdp: connection.localDescription.sdp }, { signal: run.signal }),
          answer.promise,
        ]);
        ensureActive();
        await connection.setRemoteDescription({ type: 'answer', sdp });
        await mediaConnected.promise;
        ensureActive();
        connected = true;
        established = true;
        ui.onStatus('Listening…');
      }
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
        tasks = createCodexTaskHandler(sessionId);
        const ready = milestone('connecting to the local voice server', run);

        events = new EventSource(`/api/codex/sessions/${sessionId}/events`);
        events.onerror = () => failCurrent(new Error('Voice connection was lost. Try starting again.'));
        events.onmessage = event => {
          if (!active()) return;
          let message;
          try { message = JSON.parse(event.data); }
          catch { failCurrent(new Error('Invalid voice event received.')); return; }
          if (tasks?.handle(message)) return;
          switch (message.type) {
            case 'ready': ready.resolve(); break;
            case 'thread/realtime/sdp': answer?.resolve(message.sdp); break;
            case 'error':
              failCurrent(new Error(message.message || 'Codex disconnected.'));
              break;
            case 'thread/realtime/error':
              recover(new Error(message.message || 'ChatGPT voice is unavailable for this account.'));
              break;
            case 'thread/realtime/closed':
              if (message.reason === 'transport_closed' || message.reason === 'error') {
                recover(new Error(`Voice connection ended (${message.reason}).`));
              } else {
                failCurrent(new Error(message.reason || 'Voice session ended.'));
              }
              break;
            case 'thread/realtime/transcript/delta':
            case 'thread/realtime/transcript/done': {
              if (!['user', 'assistant'].includes(message.role)) break;
              const done = message.type.endsWith('/done');
              const text = (done ? message.text : (transcripts.get(message.role) || '') + message.delta).slice(-12000);
              if (done) transcripts.delete(message.role);
              else transcripts.set(message.role, text);
              // User transcription can arrive after assistant output starts.
              // Finish collecting it without replacing the streaming reply.
              if (message.role === 'user' && transcripts.has('assistant')) break;
              // A finalization updates its displayed speaker; it is not a new turn.
              if (done && displayedRole && displayedRole !== message.role) break;
              displayedRole = message.role;
              ui.onSpeaker(message.role === 'user' ? 'User' : 'Character');
              ui.onText(text);
              break;
            }
          }
        };
        await ready.promise;
        ensureActive();
        await connectVoice('start');
      } catch (error) {
        if (controller === run) stop(error);
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
