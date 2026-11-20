/** Pure rules of the Pendenzen page (apps/web/src/pages/pendenzen/actions.ts) – the web app has no own test runner. */
import type { PendenzEntry } from '@sales-portal/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferCommit, isReplanLink, opensAnalysisReview, primaryAction, UNDO_WINDOW_MS } from '../../../../web/src/pages/pendenzen/actions';

type Item = Pick<PendenzEntry, 'kind' | 'taskType' | 'link' | 'actions'>;
const item = (over: Partial<Item>): Item => ({ kind: 'task', taskType: null, link: '/lead/L1', actions: ['open_lead'], ...over });

describe('primaryAction (Pendenzen header button)', () => {
  it('cancellation: «Neu planen» only with a link into the Termin tab', () => {
    expect(primaryAction(item({ kind: 'cancellation', link: '/lead/L1?panel=scheduling', actions: ['open_lead', 'mark_done'] }))).toEqual({
      label: 'Neu planen',
      kind: 'open',
    });
    // Sales: information only → acknowledge instead of a dead-end «Neu planen».
    expect(primaryAction(item({ kind: 'cancellation', link: '/lead/L1', actions: ['open_lead', 'mark_done'] }))).toEqual({
      label: 'Absage erledigt',
      kind: 'done',
    });
    expect(primaryAction(item({ kind: 'cancellation', link: '/lead/L1', actions: ['open_lead'] })).label).toBe('Absage ansehen');
  });

  it('analyses go to the collected review list', () => {
    expect(primaryAction(item({ kind: 'analysis' }))).toEqual({ label: 'Analysen prüfen', kind: 'review_analyses' });
    expect(opensAnalysisReview({ kind: 'analysis' })).toBe(true);
    expect(opensAnalysisReview({ kind: 'task' })).toBe(false);
  });

  it('other kinds keep their labels', () => {
    expect(primaryAction(item({ kind: 'unfinished_call' })).label).toBe('Anruf abschliessen');
    expect(primaryAction(item({ kind: 'task', taskType: 'callback' })).label).toBe('Rückruf öffnen');
    expect(primaryAction(item({ kind: 'briefing' })).label).toBe('Briefing öffnen');
    expect(primaryAction(item({ kind: 'approval' })).label).toBe('Freigabe prüfen');
    expect(primaryAction(item({ kind: 'task', taskType: 'follow_up' })).label).toBe('Nächste Pendenz öffnen');
  });

  it('isReplanLink matches only the panel parameter', () => {
    expect(isReplanLink('/lead/L1?panel=scheduling')).toBe(true);
    expect(isReplanLink('/lead/L1?x=1&panel=scheduling')).toBe(true);
    expect(isReplanLink('/lead/L1?panel=schedulingX')).toBe(false);
    expect(isReplanLink('/lead/L1?panel=mail')).toBe(false);
    expect(isReplanLink(null)).toBe(false);
  });
});

describe('deferCommit («Aufgabe erledigt» with Rückgängig)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the CRM task only after the undo window', async () => {
    const commit = vi.fn(() => Promise.resolve());
    const onCommitted = vi.fn();
    const d = deferCommit(commit, UNDO_WINDOW_MS, { onCommitted });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    expect(d.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(d.state).toBe('done');
    expect(d.cancel()).toBe(false); // too late
  });

  it('«Rückgängig» within the window writes nothing', async () => {
    const commit = vi.fn(() => Promise.resolve());
    const d = deferCommit(commit, UNDO_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(3000);
    expect(d.cancel()).toBe(true);
    expect(d.state).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(d.cancel()).toBe(false); // idempotent
  });

  it('reports a failed CRM call instead of throwing', async () => {
    const onFailed = vi.fn();
    const d = deferCommit(() => Promise.reject(new Error('CRM down')), 10, { onFailed });
    await vi.advanceTimersByTimeAsync(10);
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ message: 'CRM down' }));
    expect(d.state).toBe('failed');
  });
});
