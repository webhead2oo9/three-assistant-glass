export async function codexRequest(path, body, options = {}) {
  const response = await fetch(`/api/codex${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Assistant-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...options,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Codex request failed (${response.status}).`);
  return result;
}
