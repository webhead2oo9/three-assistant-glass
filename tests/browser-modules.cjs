const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Load actual browser modules in an isolated context with mock browser/provider APIs.
// Mock keys are repo-relative module paths ('assistant/tts.js'); a CDN module
// pulled in by a dynamic import is keyed by its full URL.
async function load(entry, globals = {}, mocks = {}) {
  const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout, ...globals });
  const cache = new Map();

  function syntheticFor(mock, identifier) {
    return new vm.SyntheticModule(Object.keys(mock), function () {
      for (const [name, value] of Object.entries(mock)) this.setExport(name, value);
    }, { context, identifier });
  }

  // Dynamic imports name a CDN URL rather than a file, so they resolve only
  // against the mocks - a test that forgets one gets a clear failure instead of
  // a network call.
  async function importDynamically(specifier) {
    const mock = mocks[specifier];
    if (!mock) throw new Error(`No mock registered for dynamic import of ${specifier}`);
    const module = syntheticFor(mock, specifier);
    await module.link(() => { throw new Error('mocked modules have no imports'); });
    await module.evaluate();
    return module;
  }

  function moduleFor(filename) {
    if (cache.has(filename)) return cache.get(filename);
    // Mock keys are written with forward slashes; path.relative uses the platform separator.
    const mock = mocks[path.relative(root, filename).split(path.sep).join('/')];
    const module = mock
      ? syntheticFor(mock, filename)
      : new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), {
        context, identifier: filename, importModuleDynamically: importDynamically,
      });
    cache.set(filename, module);
    return module;
  }
  const module = moduleFor(path.join(root, entry));
  await module.link((specifier, importer) => moduleFor(path.resolve(path.dirname(importer.identifier), specifier)));
  await module.evaluate();
  return module.namespace;
}

module.exports = { load };
