import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '../../../shared/types';
import { arrangeTiles, createSession, useWorkspaceStore } from '../../state/workspace-store';
import { useHubStore } from '../../state/hub-store';
import type { SetupMode } from './table-setup-model';

// Chat channels draw no terminal; the real module needs a DOM.
vi.mock('../../runtime/terminals', () => ({ focusTerminal: () => {}, routeTerminalEvent: () => {}, terminalDimensions: () => ({ cols: 100, rows: 24 }), releaseRemovedTerminals: () => {} }));
// Server rendering reads a store's initial state, so these hooks read the store as it is now.
vi.mock('../../state/workspace-store', async (importOriginal) => { const actual = await importOriginal<typeof import('../../state/workspace-store')>(); return { ...actual, useWorkspaceStore: Object.assign((select: (state: ReturnType<typeof actual.useWorkspaceStore.getState>) => unknown) => select(actual.useWorkspaceStore.getState()), actual.useWorkspaceStore) }; });
vi.mock('../../state/hub-store', async (importOriginal) => { const actual = await importOriginal<typeof import('../../state/hub-store')>(); return { ...actual, useHubStore: Object.assign((select: (state: ReturnType<typeof actual.useHubStore.getState>) => unknown) => select(actual.useHubStore.getState()), actual.useHubStore) }; });
const { TableSetup } = await import('./TableSetup');

afterEach(() => { useWorkspaceStore.setState({ sessions: [], tiles: [] }); });
const chat = (engine: 'claude' | 'codex', model = ''): Session => { const session = createSession(engine); return { ...session, config: engine === 'claude' ? { engine, chat: true, model, thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } } : { engine, chat: true, model, reasoningEffort: null } } as Session; };
const put = (sessions: Session[]) => useWorkspaceStore.setState({ sessions, tiles: arrangeTiles(sessions, 'grid'), layoutMode: 'grid' });
const draw = (mode: SetupMode) => renderToStaticMarkup(<TableSetup mode={mode} onClose={() => {}} />);

describe('the Round Table setup panel', () => {
  it('opens a new table with the built-in preset of the kind chosen: seats with agent, model, name and instructions, and the duties of each', () => {
    const html = draw({ type: 'new', table: 'hierarchy' });
    expect(html).toContain('New Round Table'); expect(html).toContain('<dialog'); expect(html).toContain('aria-labelledby=');
    expect(html).toMatch(/<optgroup label="Trace&#x27;s own"><option value="discussion">Claude Code and Codex · discussion<\/option><option value="hierarchy" selected="">Planner, builder, reviewer · hierarchy<\/option>/);
    for (const label of ['Seat 1 agent', 'Seat 1 model', 'Seat 1 name', 'Seat 1 instructions', 'Seat 3 duties', 'Remove Seat 2', 'Review rounds', 'Kind of table', 'Name for a saved table']) expect(html, label).toContain(`aria-label="${label}"`);
    expect(html).toContain('placeholder="Builder"'); expect(html).toContain('placeholder="Planner"'); expect(html).toContain('placeholder="Reviewer"');
    // The lead builds and only that: its Build box is checked and locked, and so are its other boxes; the seat count and the room are said.
    expect(html).toContain('Seat 1 · leads the table'); expect(html).not.toContain('Remove Seat 1'); expect(html).toContain('0 of 4,000 characters'); expect(html).toContain('Add seat'); expect(html).toContain('Start Round Table');
    const lead = html.slice(html.indexOf('aria-label="Seat 1 duties"'), html.indexOf('aria-label="Seat 2 duties"'));
    expect(lead.match(/checked=""/g)).toHaveLength(1); expect(lead.match(/<input type="checkbox"[^>]*disabled=""/g)).toHaveLength(5); expect(lead).toMatch(/<input type="checkbox" disabled="" checked=""\/>Builds/);
    const planner = html.slice(html.indexOf('aria-label="Seat 2 duties"'), html.indexOf('aria-label="Seat 3 duties"')); expect(planner).toMatch(/Plans/); expect(planner.match(/checked=""/g)).toHaveLength(2);
    expect(html).not.toContain('Delete preset'); expect(html).not.toContain('Update preset'); expect(html).toContain('Save as preset');
  });
  it('a discussion has a radio for the seat that edits files, rounds from 0, and no duties', () => {
    const html = draw({ type: 'new', table: 'discussion' });
    expect(html.match(/type="radio"/g)).toHaveLength(2); expect(html).toMatch(/<input type="radio" name="[^"]*" checked=""\/>Edits files/); expect(html).not.toContain('duties'); expect(html).toContain('aria-label="Rounds"'); expect(html).toMatch(/<option value="0">0<\/option>/);
    expect(html).toContain('How many times each agent replies to the others.');
  });
  it('lists the person’s own tables after the built-in ones, and offers Update and Delete for one of them only', () => {
    useHubStore.setState((state) => ({ preferences: { ...state.preferences, tablePresets: [{ id: 'mine-1', name: 'Two reviewers', kind: 'discussion', rounds: 1, driver: 0, seats: [{ engine: 'claude', model: '' }, { engine: 'codex', model: '' }, { engine: 'codex', model: 'gpt-5' }] }] } }));
    try {
      const html = draw({ type: 'new', table: 'discussion' }); expect(html).toContain('<optgroup label="Yours"><option value="mine-1">Two reviewers · discussion</option>');
      expect(html).not.toContain('Delete preset'); expect(html).not.toContain('Update preset');
      const own = draw({ type: 'new', table: 'discussion' }); expect(own).toContain('Save as preset');
    } finally { useHubStore.setState((state) => ({ preferences: { ...state.preferences, tablePresets: [] } })); }
  });
  it('on a chat, the chat leads with its own agent and model, which are shown and cannot be changed', () => {
    const lead = chat('codex', 'gpt-5'); put([lead]);
    const html = draw({ type: 'chat', leadId: lead.id });
    expect(html).toContain('Round Table on this chat'); expect(html).toContain('This chat leads the table with its own agent and model');
    expect(html).toMatch(/<select aria-label="Seat 1 agent" disabled=""[^>]*><option value="claude">Claude Code<\/option><option value="codex" selected="">Codex<\/option>/); const model = html.match(/<input aria-label="Seat 1 model"[^>]*>/)![0]; expect(model).toContain('value="gpt-5"'); expect(model).toContain('disabled=""');
    expect(html).toContain('This chat keeps its model; change it in the channel&#x27;s settings.'); expect(html).toMatch(/aria-label="Seat 2 agent"(?![^>]*disabled)/);
  });
  it('says no more seats fit when the eight agents and terminals leave no room, and disables Add seat and Start', () => {
    const lead = chat('claude'); put([lead, ...Array.from({ length: 6 }, () => chat('claude'))]);
    const html = draw({ type: 'chat', leadId: lead.id });
    expect(html).toContain('2 seats. This table has all the 2 seats that fit'); expect(html).toMatch(/<button type="button" class="button secondary small" disabled=""><svg[^>]*><path[^>]*><\/path><path[^>]*><\/path><\/svg>Add seat/);
    // A hierarchy of three seats does not fit in that room: the panel says so and does not offer Start.
    useWorkspaceStore.setState({ sessions: useWorkspaceStore.getState().sessions });
    const crowded = renderToStaticMarkup(<TableSetup mode={{ type: 'new', table: 'hierarchy' }} onClose={() => {}} />); expect(crowded).toContain('but only 1 fit now'); expect(crowded).toMatch(/<button type="submit" class="button primary" disabled="">Start Round Table/); expect(crowded).toContain('role="alert"');
  });
  it('edits an open table: its seats, the agent of each fixed, a model change said to restart the agent, and Apply instead of Start', () => {
    const lead = chat('claude'); const other = chat('codex', 'gpt-5');
    put([{ ...lead, roundTable: { partner: other.id, driver: 'claude', rounds: 3, driverSeat: lead.id, seats: [{ session: lead.id }, { session: other.id, name: 'Skeptic', instructions: 'Check it.' }] } }, other]);
    const html = draw({ type: 'edit', leadId: lead.id });
    expect(html).toContain('Seats at this Round Table'); expect(html).toContain('Apply'); expect(html).not.toContain('Start Round Table'); expect(html).not.toContain('aria-label="Table"');
    expect(html).toContain('Seats can only be changed while the Round Table is not working'); expect(html).toContain('Changing the model restarts this agent; its conversation is resumed.');
    expect(html).toMatch(/aria-label="Seat 2 agent" disabled=""/); expect(html).toMatch(/aria-label="Seat 2 name" placeholder="Codex" maxLength="40" value="Skeptic"/); expect(html).toContain('>Check it.</textarea>');
    expect(html.match(/type="radio"/g)).toHaveLength(2); expect(html).toMatch(/<input type="radio" name="[^"]*" checked=""\/>Edits files/); expect(html).toMatch(/<option value="3" selected="">3<\/option>/);
    expect(html).toContain('Remove Seat 2'); expect(html).not.toContain('Remove Seat 1');
  });
});
