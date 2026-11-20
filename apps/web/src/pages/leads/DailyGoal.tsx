/**
 * Tagesziel (INTENT 4, Schritt 1): «23 von 40 Anrufen heute · 6 Gespräche». Counts come from the portal's call
 * sessions (GET /api/calls/today); the goal is a personal value kept in this browser (default 40).
 * Exported for other pages (e.g. the Pendenzen side bar).
 */
import { useQuery } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Input } from '@/components/ui';
import { callApi } from '@/pages/calls';

const GOAL_KEY = 'sp.tagesziel';
export const DEFAULT_DAILY_GOAL = 40;

export function readDailyGoal(): number {
  try {
    const n = Number(localStorage.getItem(GOAL_KEY));
    return Number.isInteger(n) && n > 0 && n <= 500 ? n : DEFAULT_DAILY_GOAL;
  } catch {
    return DEFAULT_DAILY_GOAL;
  }
}

function writeDailyGoal(n: number): void {
  try {
    localStorage.setItem(GOAL_KEY, String(n));
  } catch {
    /* storage unavailable – the default stays */
  }
}

/** 0–100 (capped) for the progress bar. */
export function goalPercent(done: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(100, Math.round((done / goal) * 100));
}

export function DailyGoal() {
  const today = useQuery({ queryKey: ['calls', 'today'], queryFn: callApi.today, refetchInterval: 60_000, staleTime: 30_000 });
  const [goal, setGoal] = useState(readDailyGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(goal));
  const calls = today.data?.calls ?? 0;
  const pct = goalPercent(calls, goal);
  const valid = Number.isInteger(Number(draft)) && Number(draft) > 0 && Number(draft) <= 500;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(String(goal));
          setEditing(true);
        }}
        className="flex min-w-[190px] flex-col gap-1 rounded-md px-2 py-1 text-left hover:bg-surface-2"
        title="Tagesziel ändern"
        aria-label={`Tagesziel: ${calls} von ${goal} Anrufen heute, ${today.data?.conversations ?? 0} Gespräche`}
      >
        <span className="flex items-center gap-1.5 text-[13px] text-fg">
          <Target className="size-3.5 text-primary" aria-hidden />
          {today.isLoading ? (
            <span className="text-fg-subtle">Tagesziel …</span>
          ) : (
            <span className="tabular">
              <strong className="font-semibold">{calls}</strong> von {goal} Anrufen · {today.data?.conversations ?? 0} Gespräche
            </span>
          )}
        </span>
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </span>
      </button>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Tagesziel"
        description="Wie viele Anrufe nimmst du dir pro Tag vor? Gilt für diesen Browser."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Abbrechen
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              onClick={() => {
                const n = Number(draft);
                writeDailyGoal(n);
                setGoal(n);
                setEditing(false);
              }}
            >
              Speichern
            </Button>
          </>
        }
      >
        <Input label="Anrufe pro Tag" type="number" min={1} max={500} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-32" />
      </Dialog>
    </>
  );
}
