// Streams a chat completion through the server proxy (/api/assistant/chat),
// which adds the model, base URL and API key from settings.json so the key
// never reaches the browser and there are no CORS issues with local servers.

export async function streamChat(messages, { signal, onDelta } = {}) {
  const res = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    // SSE frames can be split across network chunks — only parse complete lines
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        // ignore keep-alive / malformed frames
      }
    }
  }
  return full;
}
