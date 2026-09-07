import { stripVTControlCharacters } from 'node:util';

// App-server text may contain terminal styling and renderer-only citation tokens.
// Clean accumulated text, not individual deltas: tokens can cross chunk boundaries.
export function cleanCodexText(text, partial = false) {
  let result = stripVTControlCharacters(text || '').replace(/\r\n/g, '\n');
  result = result.replace(/[^]*/g, '').replace(/<\/?realtime_delegation>/g, '');
  if (partial) result = result.replace(/[^]*$/, '');
  result = result.replace(/^\s*\[(?:FINAL|COMMENTARY|ANALYSIS|BACKEND)\]\s*/, '');
  if (partial && result.trimStart().startsWith('[')
    && ['[FINAL]', '[COMMENTARY]', '[ANALYSIS]', '[BACKEND]'].some(prefix => prefix.startsWith(result.trimStart()))) return '';
  return result;
}
