const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Load actual browser modules in an isolated context with mock browser/provider APIs.
async function load(entry, globals = {}, mocks = {}) {
  const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout, ...globals });
  const cache = new Map();
  function moduleFor(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const mock = mocks[path.relative(root, filename)];
    const module = mock
      ? new vm.SyntheticModule(Object.keys(mock), function () {
        for (const [name, value] of Object.entries(mock)) this.setExport(name, value);
      }, { context, identifier: filename })
      : new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename });
    cache.set(filename, module);
    return module;
  }
  const module = moduleFor(path.join(root, entry));
  await module.link((specifier, importer) => moduleFor(path.resolve(path.dirname(importer.identifier), specifier)));
  await module.evaluate();
  return module.namespace;
}

module.exports = { load };
