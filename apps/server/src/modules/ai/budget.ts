/**
 * Monthly AI cost cap (setting `ai.monthlyBudgetUsd`). Every AI call stores its usage (tokens + estimated USD) on its
 * `analyses` row; before a new call the month-to-date sum (Europe/Zurich month) is compared with the cap.
 * Mock calls cost nothing. A budget of 0 disables AI calls.
 */
import { zurichDate, zurichTime } from '@sales-portal/shared';
import { gte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { analyses } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { getSetting } from '../../lib/settings';

export function startOfZurichMonth(now: Date): Date {
  return zurichTime(`${zurichDate(now).slice(0, 7)}-01`, '00:00');
}

export async function monthToDateCostUsd(db: Db, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | number | null>`coalesce(sum((${analyses.usage}->>'costUsd')::numeric), 0)` })
    .from(analyses)
    .where(gte(analyses.createdAt, startOfZurichMonth(now)));
  return Number(row?.total ?? 0);
}

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  exceeded: boolean;
}

export async function budgetStatus(db: Db, now: Date): Promise<BudgetStatus> {
  const [spentUsd, budgetUsd] = await Promise.all([monthToDateCostUsd(db, now), getSetting(db, 'ai.monthlyBudgetUsd')]);
  return { spentUsd: Math.round(spentUsd * 100) / 100, budgetUsd, exceeded: spentUsd >= budgetUsd };
}

export const budgetExceededError = () =>
  new AppError(429, 'ai_budget_exceeded', 'Das KI-Budget für diesen Monat ist aufgebraucht. Der Admin kann es in den Einstellungen erhöhen.');

/** Throws 429 `ai_budget_exceeded` when the month's AI budget is used up. */
export async function assertAiBudget(db: Db, now: Date): Promise<void> {
  if ((await budgetStatus(db, now)).exceeded) throw budgetExceededError();
}
