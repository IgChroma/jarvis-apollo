import { createExpiringReader } from '@/idle/sources';
import { fetchDollarRate, type DollarHttpFetchImplementation } from '@/rates/dollar';

// Dólar blue para la tarjeta de la vista Casa.
//
// Reusa el cliente de dolarapi que ya usa la herramienta `dollar_rate` del
// router (rates/dollar.ts). La cotización cambia pocas veces por día: con un
// pedido cada 15 min sobra, y entre medio la etiqueta "hace N min" se recalcula
// en cada vuelta del tablero con la hora que informa dolarapi.

export const DOLLAR_BLUE_CACHE_MILLISECONDS = 15 * 60_000;
const DOLLAR_REQUEST_TIMEOUT_MILLISECONDS = 4_000;

export type DollarBlueQuote = {
  readonly buy: number;
  readonly sell: number;
  readonly updatedAtMilliseconds: number;
};

export async function readDollarBlueQuote(
  input: { readonly fetchImpl?: DollarHttpFetchImplementation } = {},
): Promise<DollarBlueQuote | undefined> {
  const fetchImpl: DollarHttpFetchImplementation =
    input.fetchImpl ??
    ((url) => fetch(url, { signal: AbortSignal.timeout(DOLLAR_REQUEST_TIMEOUT_MILLISECONDS) }));
  const rate = await fetchDollarRate({ type: 'blue', fetchImpl });
  // Sin compra o venta la tarjeta no tiene qué mostrar: mejor que no salga.
  if (rate.compra === null || rate.venta === null) {
    return undefined;
  }
  const updatedAtMilliseconds = Date.parse(rate.fechaActualizacion);
  return {
    buy: rate.compra,
    sell: rate.venta,
    updatedAtMilliseconds: Number.isFinite(updatedAtMilliseconds) ? updatedAtMilliseconds : Date.now(),
  };
}

export function createDollarBlueReader(
  input: { readonly fetchImpl?: DollarHttpFetchImplementation; readonly now?: () => number } = {},
): () => Promise<DollarBlueQuote | undefined> {
  return createExpiringReader({
    ttlMilliseconds: DOLLAR_BLUE_CACHE_MILLISECONDS,
    read: () => readDollarBlueQuote({ fetchImpl: input.fetchImpl }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
