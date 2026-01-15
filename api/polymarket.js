// /api/polymarket.js
// Backend API para Polymarket (Gamma + CLOB)
// - Soporta 2 formas de eventos Gamma:
//   1) single-market-multi-outcome: un solo market con muchos outcomes (cada outcome es una opción)
//   2) market-per-option: muchos markets binarios (Yes/No) donde cada market es una opción
//
// Refactor clave:
// - En markets binarios, NO asumir orden [NO, YES]. Resolver índices por el texto de `outcomes` ("Yes"/"No").
// - Exponer yesTokenId/noTokenId cuando existan, para poder pedir BID/ASK reales de ambos lados.
// - Mantener compatibilidad: `tokenId` sigue apuntando al YES por defecto.

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { slug, type } = req.query;

  try {
    if (type === 'market-data' && slug) {
      const data = await fetchMarketData(String(slug));
      return res.status(200).json({ success: true, ...data });
    }

    if (type === 'prices' && slug) {
      const data = await fetchPrices({
        slug: String(slug),
        tokenId: req.query.tokenId,
        outcomeIndex: req.query.outcomeIndex,
        side: req.query.side, // opcional: "yes" | "no" (si no, usa tokenId o YES por defecto)
      });
      return res.status(200).json({ success: true, ...data });
    }

    return res.status(200).json({
      success: true,
      status: 'ok',
      message: 'PolyMath Backend API is running',
      timestamp: new Date().toISOString(),
      endpoints: {
        marketData: '/api/polymarket?type=market-data&slug=YOUR_SLUG',
        pricesByToken: '/api/polymarket?type=prices&slug=YOUR_SLUG&tokenId=TOKEN_ID',
        pricesByIndex: '/api/polymarket?type=prices&slug=YOUR_SLUG&outcomeIndex=0',
        pricesByIndexSide: '/api/polymarket?type=prices&slug=YOUR_SLUG&outcomeIndex=0&side=yes',
      },
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    return res.status(status).json({ success: false, error: err?.message || 'Internal Server Error' });
  }
}

// ---------------- Utilities ----------------

function withTimeout(ms = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, timeoutId };
}

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

async function fetchJson(url, { signal } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const text = await safeReadText(r);
    const e = new Error(`HTTP ${r.status} for ${url}${text ? ` | ${text}` : ''}`);
    e.statusCode = r.status;
    throw e;
  }
  return r.json();
}

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toNumber(x, fallback = 0) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function normOutcomeLabel(x) {
  return String(x ?? '')
    .trim()
    .toLowerCase();
}

function findYesNoIndexes(outcomes) {
  const outs = Array.isArray(outcomes) ? outcomes.map(normOutcomeLabel) : [];
  const yesIdx = outs.findIndex(o => o === 'yes');
  const noIdx = outs.findIndex(o => o === 'no');
  return { yesIdx, noIdx };
}

// ---------------- Gamma ----------------

async function fetchGammaEventBySlug(slug, signal) {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const events = await fetchJson(url, { signal });
  if (!Array.isArray(events) || events.length === 0) {
    const e = new Error(`Market "${slug}" not found`);
    e.statusCode = 404;
    throw e;
  }
  return events[0];
}

function normalizeMarketArrays(market) {
  // Gamma a veces trae strings JSON
  const outcomes = parseMaybeJson(market?.outcomes, null); // array de nombres
  const outcomePrices = parseMaybeJson(market?.outcomePrices, []); // array de precios
  const clobTokenIds = parseMaybeJson(market?.clobTokenIds, []); // array de tokenIds
  return { outcomes, outcomePrices, clobTokenIds };
}

function isMultiOutcomeSingleMarket(markets) {
  if (!Array.isArray(markets) || markets.length !== 1) return false;
  const { outcomes, clobTokenIds } = normalizeMarketArrays(markets[0]);
  // Heurística: multi-outcome real suele tener >2 outcomes/tokenIds
  return (
    Array.isArray(outcomes) &&
    outcomes.length > 2 &&
    Array.isArray(clobTokenIds) &&
    clobTokenIds.length === outcomes.length
  );
}

// ---------------- Outcome builders ----------------

function buildOutcomesFromSingleMultiMarket(market) {
  const { outcomes, outcomePrices, clobTokenIds } = normalizeMarketArrays(market);

  if (!Array.isArray(outcomes) || outcomes.length === 0) return [];

  return outcomes.map((name, i) => {
    const tokenId = Array.isArray(clobTokenIds) ? clobTokenIds[i] : null;
    const price = Array.isArray(outcomePrices) ? toNumber(outcomePrices[i], 0.5) : 0.5;

    return {
      index: i, // índice del outcome dentro del market
      name: String(name),
      // En multi-outcome, cada outcome es "su token" (no es yes/no)
      tokenId: tokenId != null ? String(tokenId) : null,
      yesTokenId: tokenId != null ? String(tokenId) : null,
      noTokenId: null,
      yesPrice: clamp(price, 0, 1), // aquí "yesPrice" = precio del outcome
      noPrice: null,
      kind: 'multi-outcome',
    };
  });
}

function buildOutcomesFromMarketsAsOptions(markets) {
  // Modelo "market-per-option": cada market es una opción binaria YES/NO
  return markets.map((m, idx) => {
    const { outcomes, outcomePrices, clobTokenIds } = normalizeMarketArrays(m);

    const { yesIdx, noIdx } = findYesNoIndexes(outcomes);

    // Si Gamma no trae outcomes, hacemos fallback (menos fiable)
    const fallbackYesIdx = outcomePrices.length >= 2 ? 0 : 0; // preferimos 0 como "yes" por defecto
    const fallbackNoIdx = outcomePrices.length >= 2 ? 1 : null;

    const resolvedYesIdx = yesIdx >= 0 ? yesIdx : fallbackYesIdx;
    const resolvedNoIdx = noIdx >= 0 ? noIdx : fallbackNoIdx;

    const yesPrice =
      Array.isArray(outcomePrices) && outcomePrices.length > resolvedYesIdx
        ? toNumber(outcomePrices[resolvedYesIdx], 0.5)
        : 0.5;

    const noPrice =
      resolvedNoIdx != null &&
      Array.isArray(outcomePrices) &&
      outcomePrices.length > resolvedNoIdx
        ? toNumber(outcomePrices[resolvedNoIdx], 0.5)
        : clamp(1 - yesPrice, 0, 1);

    const yesTokenId =
      Array.isArray(clobTokenIds) && clobTokenIds.length > resolvedYesIdx
        ? clobTokenIds[resolvedYesIdx]
        : null;

    const noTokenId =
      resolvedNoIdx != null &&
      Array.isArray(clobTokenIds) &&
      clobTokenIds.length > resolvedNoIdx
        ? clobTokenIds[resolvedNoIdx]
        : null;

    return {
      index: idx, // índice del market dentro del evento
      name: m?.question || `Market ${idx + 1}`,
      // Compatibilidad: tokenId apunta al YES
      tokenId: yesTokenId != null ? String(yesTokenId) : null,
      yesTokenId: yesTokenId != null ? String(yesTokenId) : null,
      noTokenId: noTokenId != null ? String(noTokenId) : null,
      yesPrice: clamp(yesPrice, 0, 1),
      noPrice: clamp(noPrice, 0, 1),
      kind: 'binary',
      // útil para debug
      debug: {
        gammaOutcomes: Array.isArray(outcomes) ? outcomes : null,
        resolvedYesIdx,
        resolvedNoIdx,
      },
    };
  });
}

// ---------------- CLOB ----------------

async function fetchClobBest(tokenId, signal) {
  const url = `https://clob.polymarket.com/best?token_id=${encodeURIComponent(tokenId)}`;
  const data = await fetchJson(url, { signal });

  const bid = toNumber(data?.best_bid, NaN);
  const ask = toNumber(data?.best_ask, NaN);

  return {
    raw: data,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
  };
}

// ---------------- API: market-data ----------------

async function fetchMarketData(slug) {
  const { controller, timeoutId } = withTimeout(10000);
  try {
    const eventData = await fetchGammaEventBySlug(slug, controller.signal);
    const markets = Array.isArray(eventData?.markets) ? eventData.markets : [];
    if (markets.length === 0) {
      const e = new Error('No active markets for this event');
      e.statusCode = 404;
      throw e;
    }

    const marketName = eventData?.title || 'Polymarket Event';
    const totalVolume = markets.reduce((acc, m) => acc + toNumber(m?.volume, 0), 0);

    const model = isMultiOutcomeSingleMarket(markets) ? 'single-market-multi-outcome' : 'market-per-option';
    const outcomes =
      model === 'single-market-multi-outcome'
        ? buildOutcomesFromSingleMultiMarket(markets[0])
        : buildOutcomesFromMarketsAsOptions(markets);

    if (outcomes.length === 0) {
      const e = new Error('Could not build outcomes for this event (unsupported Gamma shape)');
      e.statusCode = 422;
      throw e;
    }

    // midPrice: para multi-outcome, el "best" outcome por precio; para binario, el "best" yesPrice
    const bestOutcome = outcomes.reduce((prev, curr) => (curr.yesPrice > prev.yesPrice ? curr : prev), outcomes[0]);
    const midPrice = bestOutcome?.yesPrice ?? 0.5;

    return {
      slug,
      marketName,
      volume: totalVolume,
      midPrice,
      model,
      outcomes,
      timestamp: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------- API: prices ----------------

async function fetchPrices({ slug, tokenId, outcomeIndex, side }) {
  const { controller, timeoutId } = withTimeout(10000);
  try {
    const eventData = await fetchGammaEventBySlug(slug, controller.signal);
    const markets = Array.isArray(eventData?.markets) ? eventData.markets : [];
    if (markets.length === 0) {
      const e = new Error('Market not found');
      e.statusCode = 404;
      throw e;
    }

    const model = isMultiOutcomeSingleMarket(markets) ? 'single-market-multi-outcome' : 'market-per-option';
    const outcomes =
      model === 'single-market-multi-outcome'
        ? buildOutcomesFromSingleMultiMarket(markets[0])
        : buildOutcomesFromMarketsAsOptions(markets);

    // Resolver outcome seleccionado (por tokenId o por outcomeIndex)
    let resolvedTokenId = tokenId != null ? String(tokenId) : null;
    let resolvedIndex = null;

    if (!resolvedTokenId) {
      const idx = outcomeIndex !== undefined ? parseInt(outcomeIndex, 10) : 0;
      const safeIndex = clamp(Number.isFinite(idx) ? idx : 0, 0, outcomes.length - 1);
      resolvedIndex = safeIndex;

      // Si el caller pide side=no y tenemos noTokenId, úsalo
      const s = String(side || '').toLowerCase();
      if (s === 'no' && outcomes[safeIndex]?.noTokenId) {
        resolvedTokenId = outcomes[safeIndex].noTokenId;
      } else {
        resolvedTokenId = outcomes[safeIndex]?.yesTokenId || outcomes[safeIndex]?.tokenId || null;
      }
    } else {
      // encontrar índice informativo
      const found = outcomes.findIndex(o => {
        const t = String(resolvedTokenId);
        return (
          (o?.tokenId != null && String(o.tokenId) === t) ||
          (o?.yesTokenId != null && String(o.yesTokenId) === t) ||
          (o?.noTokenId != null && String(o.noTokenId) === t)
        );
      });
      resolvedIndex = found >= 0 ? found : null;
    }

    // fallback mid desde el outcome seleccionado (si existe)
    let fallbackMid = 0.5;
    let selected = null;
    if (resolvedIndex != null && outcomes[resolvedIndex]) {
      selected = outcomes[resolvedIndex];

      const s = String(side || '').toLowerCase();
      if (s === 'no' && selected?.noPrice != null) fallbackMid = clamp(toNumber(selected.noPrice, 0.5), 0, 1);
      else fallbackMid = clamp(toNumber(selected.yesPrice, 0.5), 0, 1);
    }

    // CLOB best
    let bid = null,
      ask = null,
      clobRaw = null;

    if (resolvedTokenId) {
      try {
        const best = await fetchClobBest(resolvedTokenId, controller.signal);
        clobRaw = best.raw;
        bid = best.bid;
        ask = best.ask;
      } catch {
        // seguimos con fallback
      }
    }

    // fallback si no hay libro
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid == null || ask == null || (bid === 0 && ask === 0)) {
      ask = fallbackMid;
      bid = clamp(fallbackMid * 0.98, 0, 1);
    }

    bid = clamp(toNumber(bid, 0.5), 0, 1);
    ask = clamp(toNumber(ask, 0.5), 0, 1);
    if (bid >= ask) bid = clamp(ask * 0.98, 0, 1);

    // volumen
    let volume = 0;
    if (model === 'single-market-multi-outcome') {
      volume = toNumber(markets[0]?.volume, 0);
    } else if (resolvedIndex != null && markets[resolvedIndex]) {
      volume = toNumber(markets[resolvedIndex]?.volume, 0);
    }

    return {
      slug,
      model,
      outcomeIndex: resolvedIndex,
      tokenId: resolvedTokenId,
      bid: Number(bid.toFixed(4)),
      ask: Number(ask.toFixed(4)),
      spread: Number(((ask - bid) * 100).toFixed(2)),
      volume,
      timestamp: new Date().toISOString(),
      // debug útil durante integración
      debug: {
        usedClob: !!clobRaw,
        fallbackMid: Number(fallbackMid.toFixed(4)),
        selectedOutcome: selected
          ? {
              name: selected.name,
              kind: selected.kind,
              yesPrice: selected.yesPrice,
              noPrice: selected.noPrice,
              yesTokenId: selected.yesTokenId,
              noTokenId: selected.noTokenId,
              tokenId: selected.tokenId,
            }
          : null,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}



