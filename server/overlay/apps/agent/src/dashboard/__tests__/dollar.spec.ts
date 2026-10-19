import { describe, expect, it } from 'bun:test';

import { createDollarBlueReader, readDollarBlueQuote } from '@/dashboard/dollar';

const blueRate = {
  casa: 'blue',
  nombre: 'Blue',
  compra: 1180,
  venta: 1200,
  fechaActualizacion: '2026-10-18T17:48:00.000Z',
};

describe('readDollarBlueQuote', () => {
  it('lee compra, venta y hora de dolarapi', async () => {
    const requestedUrlList: string[] = [];
    const quote = await readDollarBlueQuote({
      fetchImpl: async (url) => {
        requestedUrlList.push(url);
        return Response.json(blueRate);
      },
    });
    expect(requestedUrlList).toEqual(['https://dolarapi.com/v1/dolares/blue']);
    expect(quote).toEqual({
      buy: 1180,
      sell: 1200,
      updatedAtMilliseconds: Date.UTC(2026, 9, 18, 17, 48),
    });
  });

  it('sin compra o venta no hay tarjeta', async () => {
    const quote = await readDollarBlueQuote({
      fetchImpl: async () => Response.json({ ...blueRate, compra: null }),
    });
    expect(quote).toBeUndefined();
  });
});

describe('createDollarBlueReader', () => {
  it('cachea 15 minutos y conserva el último valor si dolarapi falla', async () => {
    let now = 0;
    let requestCount = 0;
    let failing = false;
    const read = createDollarBlueReader({
      now: () => now,
      fetchImpl: async () => {
        requestCount += 1;
        return failing ? new Response('caído', { status: 503 }) : Response.json(blueRate);
      },
    });
    expect((await read())?.sell).toBe(1200);
    now += 14 * 60_000;
    await read();
    expect(requestCount).toBe(1);
    failing = true;
    now += 2 * 60_000;
    expect((await read())?.sell).toBe(1200);
    expect(requestCount).toBe(2);
  });
});
