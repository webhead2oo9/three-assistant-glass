(function(global) {
  const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const MODIFIER_ALIASES = new Map([
    ['ctrl', 'Ctrl'],
    ['control', 'Ctrl'],
    ['alt', 'Alt'],
    ['option', 'Alt'],
    ['shift', 'Shift'],
    ['meta', 'Meta'],
    ['cmd', 'Meta'],
    ['command', 'Meta'],
    ['os', 'Meta'],
    ['win', 'Meta'],
    ['windows', 'Meta']
  ]);
  const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS']);
  const SPECIAL_KEY_ALIASES = new Map([
    ['space', 'Space'],
    ['spacebar', 'Space'],
    ['esc', 'Escape'],
    ['plus', 'Plus']
  ]);

  function normalizeShortcutKey(key) {
    if (!key) return '';
    if (key === ' ') return 'Space';
    if (key === '+') return 'Plus';

    const keyAlias = SPECIAL_KEY_ALIASES.get(key.toLowerCase());
    if (keyAlias) return keyAlias;

    if (key === 'OS') return 'Meta';
    if (key.length === 1) return key.toUpperCase();
    return key;
  }

  function normalizeModifier(part) {
    return MODIFIER_ALIASES.get(part.trim().toLowerCase()) || '';
  }

  function createShortcutFromKeyboardEvent(event) {
    const key = normalizeShortcutKey(event.key);
    if (!key || MODIFIER_KEYS.has(key) || MODIFIER_KEYS.has(event.key)) {
      return '';
    }

    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);

    return parts.join('+');
  }

  function normalizeShortcutString(shortcut) {
    if (typeof shortcut !== 'string') return '';

    const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return '';

    const modifiers = new Set();
    let key = '';

    parts.forEach((part) => {
      const modifier = normalizeModifier(part);
      if (modifier) {
        modifiers.add(modifier);
        return;
      }

      key = normalizeShortcutKey(part);
    });

    if (!key || MODIFIER_ALIASES.has(key.toLowerCase())) {
      return '';
    }

    return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+');
  }

  const shortcutUtils = {
    createShortcutFromKeyboardEvent,
    normalizeShortcutString
  };

  global.ShortcutUtils = shortcutUtils;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = shortcutUtils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
