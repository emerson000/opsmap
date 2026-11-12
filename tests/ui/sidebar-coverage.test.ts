// AGENTS.md "Parity: the sidebar": every verb and option that acts on an object has a sidebar control on that
// object's view. A new verb, action or option fails here until it is listed below and VERB_SLOTS gives it a control.
import { describe, expect, it } from 'vitest';
import { SYNTAX, VERBS } from '../../src/core/commands/syntax';
import { UNIT_MENU, VERB_SLOTS, menuEntry, slotFor, type ObjKind } from '../../src/lib/ui/verbs';
import { ORDER_VERBS } from '../../src/lib/ui/compose';

/** Verbs the shell owns: they act on no map object (the top bar, legend, keys and map switcher reach them). */
const SHELL = ['turn', 'view', 'undo', 'redo', 'export', 'import', 'map', 'help'];
/** Verbs whose SYNTAX alternatives start with an action word: each action is its own row below. */
const ACTIONS = ['sector', 'pl', 'obj', 'ea', 'nai', 'vk'];
const area = (v: string): Record<string, ObjKind[]> => ({
  [`${v} add`]: ['map', 'sector'], [`${v} move`]: ['area'], [`${v} join`]: ['area', 'unit'], [`${v} leave`]: ['area', 'unit'],
  [`${v} size`]: ['area'], [`${v} rename`]: ['area'], [`${v} remove`]: ['area'],
});
/** What each object-acting verb (or verb action) acts on. `map` is the Situation view; a target counts (an area is attacked). */
const ACTS_ON: Record<string, ObjKind[]> = {
  new: ['map', 'sector'], id: ['unit'], size: ['unit'], fn: ['unit'], rename: ['unit'], move: ['unit', 'sector'],
  attack: ['unit', 'area'], moving: ['unit', 'area', 'pl', 'sector'], axis: ['unit', 'area', 'pl'], advancing: ['unit', 'sector'],
  bda: ['unit'], block: ['unit'], unblock: ['unit'], unpin: ['unit'], reopen: ['unit'], done: ['unit'], drop: ['unit'],
  reinforce: ['unit'], reduce: ['unit'], attach: ['unit'], detach: ['unit'], collapse: ['unit', 'map'], expand: ['unit', 'map'], link: ['unit'], due: ['unit'], note: ['unit'],
  rate: ['unit'], key: ['unit'], cp: ['unit'], halt: ['unit', 'area', 'pl', 'sector'], support: ['unit'], sidc: ['unit'],
  find: ['unit', 'area', 'pl', 'sector'], intent: ['map'], sitrep: ['map'],
  'sector add': ['map'], 'sector rename': ['sector'], 'sector remove': ['sector'], 'sector width': ['sector'], 'sector size': ['map'],
  'pl add': ['map'], 'pl date': ['pl'], 'pl rename': ['pl'], 'pl remove': ['pl'],
  ...area('obj'), ...area('ea'), ...area('nai'),
  'vk bind': ['map', 'sector'], 'vk unbind': ['map', 'sector'], 'vk sync': ['map', 'unit', 'sector'], 'vk status': ['map', 'unit', 'sector'],
};
const actionsOf = (verb: string) => [...new Set(SYNTAX[verb].split(' | ').map(alt => alt.split(' ')[0]))];
const rows = VERBS.filter(v => !SHELL.includes(v)).flatMap(v => (ACTIONS.includes(v) ? actionsOf(v).map(a => `${v} ${a}`) : [v]));

describe('sidebar coverage', () => {
  it('lists every verb and action as shell-only or object-acting', () => {
    expect(rows.filter(r => !Object.hasOwn(ACTS_ON, r)), 'add them to ACTS_ON').toEqual([]);
    expect(Object.keys(ACTS_ON).filter(r => !rows.includes(r)), 'no longer verbs').toEqual([]);
  });
  it.each(Object.entries(ACTS_ON))('%s has a sidebar control on each view it acts on', (row, kinds) => {
    const [verb, form] = row.split(' ');
    for (const kind of kinds) {
      const e = slotFor(verb, form, kind);
      expect(e, `${row} on the ${kind} view`).toBeDefined();
      expect(e!.control).toMatch(/^[a-z][a-z-]*$/);
    }
  });
  it.each(VERBS.filter(v => !SHELL.includes(v)))('every option of /%s has a slot', verb => {
    const options = (text: string) => text.match(/\[[^\]]+\]/g) ?? [];
    const slots = VERB_SLOTS.filter(e => e.verb === verb).flatMap(e => e.slots.flatMap(options));
    expect(options(SYNTAX[verb]).filter(o => !slots.includes(o))).toEqual([]);
  });
  it('the order composer offers every order verb through its unit entry', () => {
    for (const v of ORDER_VERBS) expect(slotFor(v, undefined, 'unit')?.control, v).toBe(`composer-${v}`);
    // Every verb whose slots end on a second unit or target has a composer verb or a picker control on the unit view.
    expect(['attach', 'reinforce'].map(v => slotFor(v, undefined, 'unit')?.control)).toEqual(['unit-attach', 'reinforce-with']);
    expect(slotFor('move', 'near', 'unit')?.control).toBe('unit-near');
  });
  it('builds the unit menu from the table: every item is a unit entry with a menu action, also on the unit view', () => {
    expect(new Set(UNIT_MENU.map(m => m.key)).size).toBe(UNIT_MENU.length);
    for (const m of UNIT_MENU) {
      const e = menuEntry(m.key);
      expect(e, m.key).toBeDefined();
      expect(e!.kinds, m.key).toContain('unit');
      expect(e!.menu, m.key).toBeDefined();
    }
    expect(UNIT_MENU.map(m => m.key)).toEqual(expect.arrayContaining(['attack', 'move', 'due', 'note', 'block', 'unblock', 'unpin', 'halt', 'key', 'done', 'drop', 'reopen', 'inspect']));
  });
  it('names only real verbs and gives every entry a label and a kind', () => {
    for (const e of VERB_SLOTS) {
      expect(VERBS as readonly string[]).toContain(e.verb);
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.kinds.length).toBeGreaterThan(0);
    }
  });
});
