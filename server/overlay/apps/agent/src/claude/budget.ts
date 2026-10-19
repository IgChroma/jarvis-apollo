import { API_COST_TABLE_STATEMENT } from '@/costs/ledger';
import type { MemorySqlExecutor } from '@/memory/store';
import {
  resolveCalendarDateInTimeZone,
  resolveWallClockInstantMilliseconds,
} from '@/time/zone';

// Guardián de gasto de Claude.
//
// El período va del día CLAUDE_BUDGET_CYCLE_DAY a las 00:00 (hora local) al
// mismo día del mes siguiente. Si el mes no tiene ese día (31 en abril, 30 en
// febrero), el período arranca el último día del mes.
//
// Mientras lo gastado en el período no llegue al presupuesto (menos el margen
// de CLAUDE_MIN_REMAINING_PERCENT, 0 por defecto), los turnos usan Claude.
// Cuando llega, los turnos siguientes van por OpenRouter hasta que empiece el
// período nuevo. La decisión se toma una vez al principio de cada turno: un
// turno que arranca justo debajo del límite termina en Claude aunque lo cruce.

export const CLAUDE_COST_COMPONENT = 'llm_claude';
// La suma se relee de la base como mucho cada 5 minutos (y siempre al cambiar
// de período). Entre lecturas se le suma lo que anota este proceso.
export const CLAUDE_SPEND_REFRESH_MILLISECONDS = 5 * 60 * 1000;

export type BudgetCycle = {
  readonly startMilliseconds: number;
  readonly endMilliseconds: number;
};

function daysInMonth(year: number, month: number): number {
  // Día 0 del mes siguiente = último día de este. month es 1-12.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function cycleStartInstant(
  timeZone: string,
  year: number,
  month: number,
  cycleDay: number,
): number {
  const day = Math.min(cycleDay, daysInMonth(year, month));
  return resolveWallClockInstantMilliseconds({
    timeZone,
    // weekday no se usa para resolver el instante.
    date: { year, month, day, weekday: 0 },
    hour: 0,
    minute: 0,
  });
}

export function resolveBudgetCycle(input: {
  readonly nowMilliseconds: number;
  readonly cycleDay: number;
  readonly timeZone: string;
}): BudgetCycle {
  const today = resolveCalendarDateInTimeZone(input.timeZone, input.nowMilliseconds);
  const thisMonthStart = cycleStartInstant(input.timeZone, today.year, today.month, input.cycleDay);
  if (input.nowMilliseconds >= thisMonthStart) {
    const next = shiftMonth(today.year, today.month, 1);
    return {
      startMilliseconds: thisMonthStart,
      endMilliseconds: cycleStartInstant(input.timeZone, next.year, next.month, input.cycleDay),
    };
  }
  const previous = shiftMonth(today.year, today.month, -1);
  return {
    startMilliseconds: cycleStartInstant(input.timeZone, previous.year, previous.month, input.cycleDay),
    endMilliseconds: thisMonthStart,
  };
}

export type ClaudeBudgetStatus = {
  readonly allowed: boolean;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  // Hasta dónde se puede gastar antes de pasar a OpenRouter.
  readonly limitUsd: number;
  readonly remainingUsd: number;
  readonly cycle: BudgetCycle;
};

export type ClaudeSpendGuard = {
  readonly status: (nowMilliseconds: number) => ClaudeBudgetStatus;
  // Lo que se acaba de gastar (ya anotado en api_costs por quien llama).
  readonly record: (costUsd: number, nowMilliseconds: number) => void;
};

export function createClaudeSpendGuard(dependencies: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly budgetUsd: number;
  readonly cycleDay: number;
  readonly minRemainingPercent: number;
  readonly timeZone: string;
  readonly refreshMilliseconds?: number;
}): ClaudeSpendGuard {
  const refreshMilliseconds = dependencies.refreshMilliseconds ?? CLAUDE_SPEND_REFRESH_MILLISECONDS;
  // La tabla la crea el sumidero de costos al arrancar el host; acá se asegura
  // por si el guardián se usa antes (o sin host, en tests).
  dependencies.sqlExecutor.execute(API_COST_TABLE_STATEMENT);
  let cached:
    | { cycle: BudgetCycle; spentUsd: number; readAtMilliseconds: number }
    | undefined;

  function readSpent(cycle: BudgetCycle): number {
    const rowList = dependencies.sqlExecutor.execute<{ total: number | null }>(
      'SELECT SUM(cost_usd) AS total FROM api_costs WHERE component = ? AND created_at >= ? AND created_at < ?',
      CLAUDE_COST_COMPONENT,
      cycle.startMilliseconds,
      cycle.endMilliseconds,
    );
    return rowList[0]?.total ?? 0;
  }

  function current(nowMilliseconds: number): { cycle: BudgetCycle; spentUsd: number } {
    const isStale =
      cached === undefined ||
      nowMilliseconds >= cached.cycle.endMilliseconds ||
      nowMilliseconds < cached.cycle.startMilliseconds ||
      nowMilliseconds - cached.readAtMilliseconds >= refreshMilliseconds;
    if (isStale) {
      const cycle = resolveBudgetCycle({
        nowMilliseconds,
        cycleDay: dependencies.cycleDay,
        timeZone: dependencies.timeZone,
      });
      cached = { cycle, spentUsd: readSpent(cycle), readAtMilliseconds: nowMilliseconds };
    }
    return cached!;
  }

  const limitUsd = dependencies.budgetUsd * (1 - dependencies.minRemainingPercent / 100);

  return {
    status(nowMilliseconds) {
      const { cycle, spentUsd } = current(nowMilliseconds);
      return {
        allowed: limitUsd > 0 && spentUsd < limitUsd,
        spentUsd,
        budgetUsd: dependencies.budgetUsd,
        limitUsd,
        remainingUsd: Math.max(0, dependencies.budgetUsd - spentUsd),
        cycle,
      };
    },
    record(costUsd, nowMilliseconds) {
      if (
        cached !== undefined &&
        nowMilliseconds >= cached.cycle.startMilliseconds &&
        nowMilliseconds < cached.cycle.endMilliseconds
      ) {
        cached.spentUsd += costUsd;
      }
    },
  };
}
