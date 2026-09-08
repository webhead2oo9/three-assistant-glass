// Tools the custom assistant can call (OpenAI function-calling format).
//
// Each entry is a definition sent to the model plus the handler that runs it
// on this machine. `label` is shown to the user while the tool runs.
// Definitions are emitted in a fixed order so the request prefix stays stable
// for provider-side prompt caching.

import { localTimeZone } from './prompt.mjs';

export function createTools({ openUrl = defaultOpenUrl, now = () => new Date(), timeZone = localTimeZone() } = {}) {
  const tools = [
    {
      name: 'get_time',
      label: 'Checking the time…',
      description: 'Get the current local date and time, to the minute. Call this when the user asks what time it is or needs the exact time; the date and hour in the system prompt are only approximate.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const date = now();
        return {
          time: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date),
          date: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date),
          timezone: timeZone,
          iso: date.toISOString(),
        };
      },
    },
    {
      name: 'open_url',
      label: 'Opening a link…',
      description: "Open a web page in the user's default browser. Only use it when the user asks to open, show or go to a website.",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http or https URL' } },
        required: ['url'],
        additionalProperties: false,
      },
      async run({ url } = {}) {
        let parsed;
        try { parsed = new URL(String(url)); } catch { return { error: 'Invalid URL' }; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'Only http and https URLs can be opened' };
        await openUrl(parsed.href);
        return { opened: parsed.href };
      },
    },
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    definitions: () => tools.map(({ name, description, parameters }) => ({
      type: 'function',
      function: { name, description, parameters },
    })),
    label: (name) => byName.get(name)?.label || `Running ${name}…`,
    async run(name, args) {
      const tool = byName.get(name);
      if (!tool) return { error: `Unknown tool: ${name}` };
      try {
        return await tool.run(args ?? {});
      } catch (error) {
        return { error: error.message || String(error) };
      }
    },
  };
}

async function defaultOpenUrl(url) {
  const { default: open } = await import('open');
  await open(url);
}
