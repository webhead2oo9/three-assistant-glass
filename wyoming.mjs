/**
 * Wyoming protocol TCP framing helpers.
 *
 * Each Wyoming message is:
 *   <JSON header line>\n
 *   [payload_length bytes of binary data]
 *
 * Header fields: type, data (object), data_length, payload_length
 */

/**
 * Write a single Wyoming event to a net.Socket.
 * @param {net.Socket} socket
 * @param {string} type
 * @param {object} [data]
 * @param {Buffer} [payload]
 */
export function sendEvent(socket, type, data = {}, payload = null) {
  const header = JSON.stringify({
    type,
    data,
    data_length: 0,
    payload_length: payload ? payload.length : 0,
  });
  socket.write(header + '\n');
  if (payload && payload.length > 0) {
    socket.write(payload);
  }
}

/**
 * Async generator that reads Wyoming events from a net.Socket.
 * Yields { type, data, payload } objects.
 * @param {net.Socket} socket
 */
export async function* readEvents(socket) {
  let buf = Buffer.alloc(0);
  let done = false;

  const chunks = [];
  let resolveChunk = null;

  // Register close/end/data listeners once — avoids the MaxListeners leak
  // that occurs when socket.once('close') is called inside nextChunk()
  function onDone() {
    done = true;
    if (resolveChunk) { resolveChunk(null); resolveChunk = null; }
  }
  socket.once('close', onDone);
  socket.once('end', onDone);

  socket.on('data', (chunk) => {
    if (resolveChunk) {
      const resolve = resolveChunk;
      resolveChunk = null;
      resolve(chunk);
    } else {
      chunks.push(chunk);
    }
  });

  function nextChunk() {
    if (chunks.length > 0) return Promise.resolve(chunks.shift());
    if (done) return Promise.resolve(null);
    return new Promise((resolve) => {
      resolveChunk = resolve;
    });
  }

  while (!done) {
    // Find newline in buffer (end of JSON header)
    let nlIdx = buf.indexOf(0x0a); // '\n'
    while (nlIdx === -1) {
      const chunk = await nextChunk();
      if (chunk === null) return;
      buf = Buffer.concat([buf, chunk]);
      nlIdx = buf.indexOf(0x0a);
    }

    // Parse header
    const headerLine = buf.slice(0, nlIdx).toString('utf8').trim();
    buf = buf.slice(nlIdx + 1);

    let header;
    try {
      header = JSON.parse(headerLine);
    } catch (e) {
      console.warn('[Wyoming] failed to parse header, raw bytes:', buf.slice(0, Math.min(nlIdx, 200)).toString('hex'));
      console.warn('[Wyoming] header text was:', headerLine.slice(0, 200));
      continue;
    }

    const dataLen = header.data_length || 0;
    const payloadLen = header.payload_length || 0;

    // Skip inline data section if present (data_length bytes before payload)
    while (buf.length < dataLen + payloadLen) {
      const chunk = await nextChunk();
      if (chunk === null) return;
      buf = Buffer.concat([buf, chunk]);
    }

    // If data_length > 0, the data JSON comes as separate bytes (not in the header object)
    let data = header.data || {};
    if (dataLen > 0) {
      try {
        data = JSON.parse(buf.slice(0, dataLen).toString('utf8'));
      } catch {
        // keep header.data as fallback
      }
      buf = buf.slice(dataLen);
    }

    const payload = payloadLen > 0 ? buf.slice(0, payloadLen) : null;
    buf = buf.slice(payloadLen);

    yield { type: header.type, data, payload };
  }
}

/**
 * Build a minimal 44-byte WAV header for raw PCM audio.
 * @param {number} dataLen - byte length of the PCM data
 * @param {number} sampleRate - e.g. 22050
 * @param {number} channels - e.g. 1
 * @param {number} bitDepth - e.g. 16
 * @returns {Buffer}
 */
export function buildWavHeader(dataLen, sampleRate = 22050, channels = 1, bitDepth = 16) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const buf = Buffer.alloc(44);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);           // fmt chunk size
  buf.writeUInt16LE(1, 20);            // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  return buf;
}
