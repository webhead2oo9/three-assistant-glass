// System prompt placeholders, filled in by the server on every request.
//
// Only coarse values are offered on purpose: providers cache the prompt
// prefix, and a minute-level time would invalidate that cache on every turn.
//   {{date}}      Sunday, September 7, 2026
//   {{hour}}      3 PM
//   {{timezone}}  America/Los_Angeles
// The exact time is a tool (get_time) the model calls only when asked.

export function promptVariables({ now = new Date(), timeZone = localTimeZone() } = {}) {
  const format = (options) => new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(now);
  return {
    date: format({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    hour: format({ hour: 'numeric', hour12: true }),
    timezone: timeZone,
  };
}

export function renderPrompt(text, variables = promptVariables()) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
    Object.hasOwn(variables, name) ? variables[name] : match);
}

// Renders placeholders in every system message; other messages are untouched.
export function renderSystemMessages(messages, variables = promptVariables()) {
  return messages.map((message) =>
    message?.role === 'system' && typeof message.content === 'string'
      ? { ...message, content: renderPrompt(message.content, variables) }
      : message);
}

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
