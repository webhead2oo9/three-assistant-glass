// A dropdown menu drawn in the page's own style.
//
// Chrome draws both a <select>'s menu and a <datalist>'s suggestion list
// itself, outside the document: square corners, system font, flat white. Next
// to the redesign's paper cards and green chevrons those popups read as
// foreign, and they do not even match each other - a provider menu and a model
// menu are two different widgets. No CSS reaches either one, so the menu is
// drawn here instead.
//
// The native elements stay the source of truth. A <select> keeps its options
// and its value and is only hidden; every pick is written back through it with
// a real change event, so settings.js's field table, dirty tracking and
// validation carry on reading exactly the DOM they always read. A suggestion
// field stays a visible, typeable <input> - the panel only offers what the
// endpoint advertised, which is the whole reason those fields are inputs and
// not selects.

const MAX_PANEL_HEIGHT = 288;   // roughly seven rows, then it scrolls
const GAP = 6;                  // between the field and its panel

let panelSeq = 0;
let active = null;   // the one combobox whose panel is open, if any

function closeActive() {
    active?.close();
}

// One menu at a time, and a press anywhere else dismisses it - the same
// contract the native menus have.
document.addEventListener('pointerdown', (event) => {
    if (active && !active.owns(event.target)) closeActive();
}, true);

document.addEventListener('focusin', (event) => {
    if (active && !active.owns(event.target)) closeActive();
});

// A fixed panel would otherwise drift away from the field it belongs to.
window.addEventListener('scroll', () => active?.position(), true);
window.addEventListener('resize', () => active?.position());

// Panels live on <body> rather than beside their field so that no card, tab
// strip or overflow rule can clip them.
function createPanel(controller) {
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    panel.id = `comboPanel${++panelSeq}`;
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;

    // Pointer-down would move focus off the field before the click lands.
    panel.addEventListener('mousedown', (event) => event.preventDefault());
    panel.addEventListener('click', (event) => {
        const row = event.target.closest('.combo-option');
        if (row) controller.commit(row.dataset.value);
    });
    panel.addEventListener('mousemove', (event) => {
        const row = event.target.closest('.combo-option');
        if (row && !row.classList.contains('is-active')) {
            controller.setCursor([...panel.children].indexOf(row));
        }
    });

    document.body.append(panel);
    return panel;
}

// entries: { value, label, note }
function renderOptions(panel, entries, selected, cursor) {
    panel.replaceChildren();
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = 'No matches';
        panel.append(empty);
        return;
    }
    entries.forEach((entry, i) => {
        const row = document.createElement('div');
        row.className = 'combo-option';
        row.id = `${panel.id}o${i}`;
        row.setAttribute('role', 'option');
        row.dataset.value = entry.value;
        if (entry.value === selected) row.setAttribute('aria-selected', 'true');
        if (i === cursor) row.classList.add('is-active');

        const label = document.createElement('span');
        label.className = 'combo-option-label';
        label.textContent = entry.label;
        row.append(label);

        if (entry.note) {
            const note = document.createElement('span');
            note.className = 'combo-option-note';
            note.textContent = entry.note;
            row.append(note);
        }
        panel.append(row);
    });
}

// Sizes and places an already-visible panel under - or, low on the page, over -
// its field. The height cap has to be applied before the panel is measured, or
// a long catalogue would report its full height and always flip.
function placePanel(panel, anchor) {
    const rect = anchor.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP - 8;
    const above = rect.top - GAP - 8;

    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.maxHeight = `${Math.min(MAX_PANEL_HEIGHT, Math.max(120, below, above))}px`;

    const height = panel.offsetHeight;
    const flip = height > below && above > below;
    panel.style.top = flip ? `${rect.top - GAP - height}px` : `${rect.bottom + GAP}px`;
}

// Wraps a control in the positioning container both flavours share. It wraps
// rather than clips, so a .field-error inserted next to the control still
// lands on its own line.
function wrapControl(el, extraClass) {
    const box = document.createElement('div');
    box.className = `combo ${extraClass}`;
    el.replaceWith(box);
    box.append(el);
    return box;
}

// A <label for> pointing at a control we are about to hide still has to name
// something, so the label is re-pointed at whatever replaced it.
function retargetLabel(source, target) {
    if (!source.id) return;
    const label = document.querySelector(`label[for="${CSS.escape(source.id)}"]`);
    if (!label) return;
    if (!label.id) label.id = `${source.id}ComboLabel`;
    target.setAttribute('aria-labelledby', label.id);
}

// ─── A <select> ──────────────────────────────────────────────────────────────

export function enhanceSelect(select) {
    if (!select || select.dataset.combo) return;
    select.dataset.combo = 'select';

    const box = wrapControl(select, 'combo-select');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'combo-button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    const valueEl = document.createElement('span');
    valueEl.className = 'combo-value';
    button.append(valueEl);
    box.append(button);
    retargetLabel(select, button);

    let panel = null;
    let entries = [];
    let cursor = -1;

    // The button is never more than a view of the select.
    const sync = () => {
        const chosen = select.selectedOptions[0];
        valueEl.textContent = chosen ? chosen.textContent.trim() : '';
        valueEl.classList.toggle('is-empty', !chosen || chosen.value === '');
        button.disabled = select.disabled;
        button.title = select.title;
    };

    // Options arrive late in two places - the animation list and the Vapi
    // assistant list are both filled by a fetch - and applySettings() assigns
    // to .value, which fires no event at all. Both have to reach the button, or
    // it would sit showing a stale choice over a select that had moved on.
    new MutationObserver(sync).observe(select, {
        childList: true, subtree: true, characterData: true, attributes: true,
    });
    select.addEventListener('change', sync);

    const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
        configurable: true,
        enumerable: true,
        get() { return nativeValue.get.call(this); },
        set(next) { nativeValue.set.call(this, next); sync(); },
    });

    const isOpen = () => box.classList.contains('is-open');

    const draw = () => {
        renderOptions(panel, entries, select.value, cursor);
        if (cursor >= 0) button.setAttribute('aria-activedescendant', `${panel.id}o${cursor}`);
    };

    // Only worth doing once the panel has been capped by placePanel; before
    // that it is as tall as its contents and has nothing to scroll.
    const reveal = () => {
        if (cursor >= 0) panel.children[cursor]?.scrollIntoView({ block: 'nearest' });
    };

    const open = () => {
        if (button.disabled) return;
        closeActive();
        panel ||= createPanel(controller);
        button.setAttribute('aria-controls', panel.id);

        entries = [...select.options].map(o => ({ value: o.value, label: o.textContent.trim(), note: '' }));
        cursor = Math.max(0, select.selectedIndex);

        panel.hidden = false;
        box.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        active = controller;
        draw();
        placePanel(panel, button);
        reveal();
    };

    const controller = {
        owns: (node) => box.contains(node) || Boolean(panel?.contains(node)),
        position: () => panel && placePanel(panel, button),
        close(restoreFocus = false) {
            if (active === controller) active = null;
            if (panel) panel.hidden = true;
            box.classList.remove('is-open');
            button.setAttribute('aria-expanded', 'false');
            button.removeAttribute('aria-activedescendant');
            if (restoreFocus) button.focus();
        },
        commit(value) {
            if (select.value !== value) {
                select.value = value;   // through the setter above, so sync() runs
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            controller.close(true);
        },
        setCursor(index) {
            if (index < 0 || index >= entries.length) return;
            cursor = index;
            draw();
            reveal();
        },
    };

    const move = (delta) => {
        if (entries.length) controller.setCursor((cursor + delta + entries.length) % entries.length);
    };

    button.addEventListener('click', () => (isOpen() ? controller.close() : open()));

    button.addEventListener('keydown', (event) => {
        switch (event.key) {
            case 'ArrowDown': event.preventDefault(); isOpen() ? move(1) : open(); break;
            case 'ArrowUp': event.preventDefault(); isOpen() ? move(-1) : open(); break;
            case 'Home': if (isOpen()) { event.preventDefault(); controller.setCursor(0); } break;
            case 'End': if (isOpen()) { event.preventDefault(); controller.setCursor(entries.length - 1); } break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                if (isOpen() && entries[cursor]) controller.commit(entries[cursor].value);
                else open();
                break;
            case 'Escape': if (isOpen()) { event.preventDefault(); controller.close(true); } break;
            case 'Tab': if (isOpen()) controller.close(); break;
        }
    });

    sync();
}

// ─── An <input> backed by a <datalist> ───────────────────────────────────────
//
// The input stays exactly what it was - free text, typeable, holding whatever
// the user wants. Only the suggestion popup changes hands.

export function enhanceCombobox(input) {
    if (!input || input.dataset.combo) return;
    const source = input.list;
    if (!source) return;
    input.dataset.combo = 'input';
    input.removeAttribute('list');   // the native suggestion popup, off
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');

    const box = wrapControl(input, 'combo-input');

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'combo-chevron';
    chevron.tabIndex = -1;   // the input is the tab stop; this is a shortcut
    chevron.setAttribute('aria-label', 'Show suggestions');
    box.append(chevron);

    let panel = null;
    let entries = [];
    let cursor = -1;

    // Read live: fillDatalist() rewrites the <datalist> every time an endpoint
    // is re-polled, and a copy taken here would go stale behind it.
    const suggestions = () => [...source.options].map(o => ({
        value: o.value,
        label: o.value,
        note: o.textContent.trim(),
    }));

    // Typing narrows the list, but a value matching an entry exactly shows the
    // whole catalogue - otherwise picking one would leave you looking at a list
    // of one, with no way to see what else was on offer.
    const matching = () => {
        const all = suggestions();
        const typed = input.value.trim().toLowerCase();
        if (!typed || all.some(e => e.value.toLowerCase() === typed)) return all;
        return all.filter(e => e.value.toLowerCase().includes(typed)
            || e.note.toLowerCase().includes(typed));
    };

    const isOpen = () => box.classList.contains('is-open');

    const draw = () => {
        renderOptions(panel, entries, input.value, cursor);
        if (cursor >= 0) input.setAttribute('aria-activedescendant', `${panel.id}o${cursor}`);
        else input.removeAttribute('aria-activedescendant');
    };

    // Only worth doing once the panel has been capped by placePanel; before
    // that it is as tall as its contents and has nothing to scroll.
    const reveal = () => {
        if (cursor >= 0) panel.children[cursor]?.scrollIntoView({ block: 'nearest' });
    };

    // A field with nothing to suggest stays a plain text box rather than
    // opening an empty menu - the same graceful degradation .has-suggestions
    // already gives the chevron.
    const open = () => {
        entries = matching();
        if (!entries.length) return controller.close();
        closeActive();
        panel ||= createPanel(controller);
        input.setAttribute('aria-controls', panel.id);

        cursor = entries.findIndex(e => e.value === input.value);
        panel.hidden = false;
        box.classList.add('is-open');
        input.setAttribute('aria-expanded', 'true');
        active = controller;
        draw();
        placePanel(panel, input);
        reveal();
    };

    const refilter = () => {
        if (!isOpen()) return;
        entries = matching();
        if (!entries.length) return controller.close();
        cursor = entries.findIndex(e => e.value === input.value);
        draw();
        placePanel(panel, input);
        reveal();
    };

    const controller = {
        owns: (node) => box.contains(node) || Boolean(panel?.contains(node)),
        position: () => panel && placePanel(panel, input),
        close(restoreFocus = false) {
            if (active === controller) active = null;
            if (panel) panel.hidden = true;
            box.classList.remove('is-open');
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            if (restoreFocus) input.focus();
        },
        commit(value) {
            if (input.value !== value) {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            controller.close(true);
        },
        setCursor(index) {
            if (index < 0 || index >= entries.length) return;
            cursor = index;
            draw();
            reveal();
        },
    };

    const move = (delta) => {
        if (entries.length) controller.setCursor((cursor + delta + entries.length) % entries.length);
    };

    // Clicking the text still just places the caret; only the chevron opens the
    // list. A value the server never advertised is as typeable as it ever was.
    chevron.addEventListener('mousedown', (event) => event.preventDefault());
    chevron.addEventListener('click', () => {
        input.focus();
        isOpen() ? controller.close() : open();
    });

    // commit() dispatches 'input' too, so this has to survive re-entry; by then
    // the panel is closed and refilter() is a no-op.
    input.addEventListener('input', refilter);

    input.addEventListener('keydown', (event) => {
        switch (event.key) {
            case 'ArrowDown': event.preventDefault(); isOpen() ? move(1) : open(); break;
            case 'ArrowUp': event.preventDefault(); isOpen() ? move(-1) : open(); break;
            case 'Enter':
                if (isOpen() && entries[cursor]) { event.preventDefault(); controller.commit(entries[cursor].value); }
                break;
            case 'Escape': if (isOpen()) { event.preventDefault(); controller.close(true); } break;
            case 'Tab': if (isOpen()) controller.close(); break;
        }
    });
}
