import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  CLAUDE_SPEND_REFRESH_MILLISECONDS,
  createClaudeSpendGuard,
  resolveBudgetCycle,
} from '@/claude/budget';
import { createSqliteApiCostSink, type ApiCostEntry } from '@/costs/ledger';
import { createBunSqliteExecutor } from '@/platform/bun/sql';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const at = (iso: string) => Date.parse(iso);
const DAY = 24 * 60 * 60 * 1000;

function cycleOf(iso: string, cycleDay = 12, timeZone = BUENOS_AIRES) {
  const cycle = resolveBudgetCycle({ nowMilliseconds: at(iso), cycleDay, timeZone });
  return {
    from: new Date(cycle.startMilliseconds).toISOString(),
    to: new Date(cycle.endMilliseconds).toISOString(),
  };
}

describe('Claude budget cycle', () => {
  it('runs from day 12 at local midnight to day 12 of the next month', () => {
    // Buenos Aires es UTC-3: las 00:00 locales son las 03:00 UTC.
    expect(cycleOf('2026-10-18T12:00:00Z')).toEqual({
      from: '2026-10-12T03:00:00.000Z',
      to: '2026-11-12T03:00:00.000Z',
    });
  });

  it('uses local time at the boundary, not UTC', () => {
    // 11 de octubre 23:59:59 en Buenos Aires (ya es 12 en UTC): período anterior.
    expect(cycleOf('2026-10-12T02:59:59Z')).toEqual({
      from: '2026-09-12T03:00:00.000Z',
      to: '2026-10-12T03:00:00.000Z',
    });
    // 12 de octubre 00:00:00 local: arranca el nuevo.
    expect(cycleOf('2026-10-12T03:00:00Z').from).toBe('2026-10-12T03:00:00.000Z');
  });

  it('spans 31-, 28- and 30-day months with cycle day 12', () => {
    const length = (iso: string) => {
      const cycle = resolveBudgetCycle({ nowMilliseconds: at(iso), cycleDay: 12, timeZone: BUENOS_AIRES });
      return (cycle.endMilliseconds - cycle.startMilliseconds) / DAY;
    };
    expect(length('2026-01-20T12:00:00Z')).toBe(31); // 12 ene → 12 feb
    expect(length('2026-02-20T12:00:00Z')).toBe(28); // 12 feb → 12 mar (2026 no es bisiesto)
    expect(length('2026-04-20T12:00:00Z')).toBe(30); // 12 abr → 12 may
    expect(cycleOf('2026-03-05T12:00:00Z')).toEqual({
      from: '2026-02-12T03:00:00.000Z',
      to: '2026-03-12T03:00:00.000Z',
    });
  });

  it('clamps a cycle day the month does not have to its last day', () => {
    expect(cycleOf('2026-02-20T12:00:00Z', 31)).toEqual({
      from: '2026-01-31T03:00:00.000Z',
      to: '2026-02-28T03:00:00.000Z',
    });
    expect(cycleOf('2026-03-01T12:00:00Z', 31)).toEqual({
      from: '2026-02-28T03:00:00.000Z',
      to: '2026-03-31T03:00:00.000Z',
    });
    expect(cycleOf('2026-04-15T12:00:00Z', 31)).toEqual({
      from: '2026-03-31T03:00:00.000Z',
      to: '2026-04-30T03:00:00.000Z',
    });
    // 2028 es bisiesto.
    expect(cycleOf('2028-02-10T12:00:00Z', 30)).toEqual({
      from: '2028-01-30T03:00:00.000Z',
      to: '2028-02-29T03:00:00.000Z',
    });
  });

  it('wraps across the year', () => {
    expect(cycleOf('2027-01-05T12:00:00Z')).toEqual({
      from: '2026-12-12T03:00:00.000Z',
      to: '2027-01-12T03:00:00.000Z',
    });
  });

  it('follows daylight saving time in zones that have it', () => {
    // Madrid: CEST (UTC+2) el 12 de octubre, CET (UTC+1) el 12 de noviembre.
    expect(cycleOf('2026-10-30T12:00:00Z', 12, 'Europe/Madrid')).toEqual({
      from: '2026-10-11T22:00:00.000Z',
      to: '2026-11-11T23:00:00.000Z',
    });
  });
});

function createLedger() {
  const executor = createBunSqliteExecutor(new Database(':memory:'));
  let clock = 0;
  const sink = createSqliteApiCostSink(executor, () => clock);
  const write = (iso: string, entry: Partial<ApiCostEntry>) => {
    clock = at(iso);
    sink({ component: 'llm_claude', model: 'claude-haiku-5-5', costUsd: 0, ...entry });
  };
  return { executor, write };
}

describe('Claude spend guard', () => {
  const guardFor = (executor: ReturnType<typeof createLedger>['executor'], overrides = {}) =>
    createClaudeSpendGuard({
      sqlExecutor: executor,
      budgetUsd: 50, // el default
      cycleDay: 12,
      minRemainingPercent: 0,
      timeZone: BUENOS_AIRES,
      ...overrides,
    });

  it('allows Claude until the cycle spend reaches the whole budget', () => {
    const { executor, write } = createLedger();
    write('2026-10-13T12:00:00Z', { costUsd: 30 });
    write('2026-10-14T12:00:00Z', { costUsd: 19.99 });
    const underLimit = guardFor(executor).status(at('2026-10-18T12:00:00Z'));
    expect(underLimit.allowed).toBe(true);
    expect(underLimit.spentUsd).toBeCloseTo(49.99, 6);
    expect(underLimit.limitUsd).toBe(50);

    write('2026-10-15T12:00:00Z', { costUsd: 0.01 });
    const atLimit = guardFor(executor).status(at('2026-10-18T12:00:00Z'));
    expect(atLimit.allowed).toBe(false);
    expect(atLimit.remainingUsd).toBeCloseTo(0, 6);
  });

  it('only counts Claude rows inside the current cycle', () => {
    const { executor, write } = createLedger();
    write('2026-10-11T12:00:00Z', { costUsd: 500 }); // período anterior
    write('2026-10-13T12:00:00Z', { component: 'llm', model: 'deepseek', costUsd: 500 });
    write('2026-10-13T12:00:00Z', { costUsd: 2 });
    expect(guardFor(executor).status(at('2026-10-18T12:00:00Z')).spentUsd).toBeCloseTo(2, 6);
  });

  it('keeps a safety margin when CLAUDE_MIN_REMAINING_PERCENT is set', () => {
    const { executor, write } = createLedger();
    write('2026-10-13T12:00:00Z', { costUsd: 35 });
    const guard = guardFor(executor, { minRemainingPercent: 30 });
    const status = guard.status(at('2026-10-18T12:00:00Z'));
    expect(status.limitUsd).toBeCloseTo(35, 6);
    expect(status.allowed).toBe(false);
  });

  it('adds what this process spends between reads and re-reads every few minutes', () => {
    const { executor, write } = createLedger();
    write('2026-10-13T12:00:00Z', { costUsd: 49 });
    const guard = guardFor(executor);
    const now = at('2026-10-18T12:00:00Z');
    expect(guard.status(now).allowed).toBe(true);

    // Una llamada cara: se anota en la base y en el guardián.
    write('2026-10-18T12:00:01Z', { costUsd: 1.5 });
    guard.record(1.5, now + 1000);
    expect(guard.status(now + 2000).allowed).toBe(false);

    // Algo que anotó otro proceso aparece recién al releer.
    const fresh = guardFor(executor);
    fresh.status(now);
    write('2026-10-18T12:00:02Z', { costUsd: 10 });
    expect(fresh.status(now + 60_000).spentUsd).toBeCloseTo(50.5, 6);
    expect(fresh.status(now + CLAUDE_SPEND_REFRESH_MILLISECONDS).spentUsd).toBeCloseTo(60.5, 6);
  });

  it('switches back to Claude when the next cycle starts', () => {
    const { executor, write } = createLedger();
    write('2026-10-13T12:00:00Z', { costUsd: 60 });
    const guard = guardFor(executor);
    expect(guard.status(at('2026-11-12T02:59:00Z')).allowed).toBe(false);
    // Un minuto después de la medianoche local del 12: período nuevo, sin
    // esperar a que venza el refresco de la suma.
    const nextCycle = guard.status(at('2026-11-12T03:01:00Z'));
    expect(nextCycle.allowed).toBe(true);
    expect(nextCycle.spentUsd).toBe(0);
  });

  it('never allows Claude with a zero budget', () => {
    const { executor } = createLedger();
    expect(guardFor(executor, { budgetUsd: 0 }).status(at('2026-10-18T12:00:00Z')).allowed).toBe(false);
  });
});
