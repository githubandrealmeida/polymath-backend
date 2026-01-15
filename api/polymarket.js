// /api/polymarket.js
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
      const data = await fetchMarketData(slug);
      return res.status(200).json({ success: true, ...data });
    }

    if (type === 'prices' && slug) {
      const data = await fetchPrices({
        slug,
        tokenId: req.query.tokenId,
        outcomeIndex: req.query.outcomeIndex
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
        pricesLegacy: '/api/polymarket?type=prices&slug=YOUR_SLUG&outcomeIndex=0'
      }
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    return res.status(status).json({ success: false, error: err?.message || 'Internal Server Error' });
  }
}

// ---------------- Helpers ----------------

function withTimeout(ms = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, timeoutId };
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

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toNumber(x, fallback = 0) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

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
  const outcomes = parseMaybeJson(market?.outcomes, null);          // array de nombres (multi)
  const outcomePrices = parseMaybeJson(market?.outcomePrices, []); // array de precios
  const clobTokenIds = parseMaybeJson(market?.clobTokenIds, []);   // array de tokenIds
  return { outcomes, outcomePrices, clobTokenIds };
}

function isMultiOutcomeSingleMarket(markets) {
  if (!Array.isArray(markets) || markets.length !== 1) return false;
  const { outcomes, clobTokenIds } = normalizeMarketArrays(markets[0]);
  // Heurística: multi-outcome real suele tener >2 outcomes/tokenIds
  return Array.isArray(outcomes) && outcomes.length > 2 && Array.isArray(clobTokenIds) && clobTokenIds.length === outcomes.length;
}

function buildOutcomesFromSingleMultiMarket(market) {
  const { outcomes, outcomePrices, clobTokenIds } = normalizeMarketArrays(market);

  // Si falta algo crítico, devolvemos vacío para que el caller haga fallback
  if (!Array.isArray(outcomes) || outcomes.length === 0) return [];

  return outcomes.map((name, i) => {
    const tokenId = Array.isArray(clobTokenIds) ? clobTokenIds[i] : null;
    const price = Array.isArray(outcomePrices) ? toNumber(outcomePrices[i], 0.5) : 0.5;

    return {
      index: i,                 // índice del outcome dentro del market
      name: String(name),
      tokenId: tokenId != null ? String(tokenId) : null,
      yesPrice: clamp(price, 0, 1) // aquí "yesPrice" significa "precio del outcome"
    };
  });
}

function buildOutcomesFromMarketsAsOptions(markets) {
  // Modelo "market-per-option": cada market es una opción binaria NO/YES
  return markets.map((m, idx) => {
    const { outcomePrices, clobTokenIds } = normalizeMarketArrays(m);

    // Heurística binaria: [NO, YES] => YES es el segundo
    const yesPrice = outcomePrices.length >= 2 ? toNumber(outcomePrices[1], 0.5) : toNumber(outcomePrices[0], 0.5);
    const yesTokenId = clobTokenIds.length >= 2 ? clobTokenIds[1] : clobTokenIds[0];

    return {
      index: idx, // índice del market dentro del evento
      name: m?.question || `Market ${idx + 1}`,
      tokenId: yesTokenId != null ? String(yesTokenId) : null,
      yesPrice: clamp(yesPrice, 0, 1)
    };
  });
}

async function fetchClobBest(tokenId, signal) {
  const url = `https://clob.polymarket.com/best?token_id=${encodeURIComponent(tokenId)}`;
  const data = await fetchJson(url, { signal });

  // soportar varias claves posibles
  const bid = toNumber(data?.best_bid, NaN);
  const ask = toNumber(data?.best_ask, NaN);

  return {
    raw: data,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null
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

    // volumen total (sumando markets)
    const totalVolume = markets.reduce((acc, m) => acc + toNumber(m?.volume, 0), 0);

    let model = 'market-per-option';
    let outcomes = [];

    if (isMultiOutcomeSingleMarket(markets)) {
      model = 'single-market-multi-outcome';
      outcomes = buildOutcomesFromSingleMultiMarket(markets[0]);
    } else {
      outcomes = buildOutcomesFromMarketsAsOptions(markets);
    }

    if (outcomes.length === 0) {
      const e = new Error('Could not build outcomes for this event (unsupported Gamma shape)');
      e.statusCode = 422;
      throw e;
    }

    const bestOutcome = outcomes.reduce((prev, curr) => (curr.yesPrice > prev.yesPrice ? curr : prev), outcomes[0]);
    const midPrice = bestOutcome?.yesPrice ?? 0.5;

    return {
      slug,
      marketName,
      volume: totalVolume,
      midPrice,
      model,
      outcomes,
      timestamp: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------- API: prices ----------------

async function fetchPrices({ slug, tokenId, outcomeIndex }) {
  const { controller, timeoutId } = withTimeout(10000);
  try {
    const eventData = await fetchGammaEventBySlug(slug, controller.signal);
    const markets = Array.isArray(eventData?.markets) ? eventData.markets : [];
    if (markets.length === 0) {
      const e = new Error('Market not found');
      e.statusCode = 404;
      throw e;
    }

    // Construimos outcomes con el mismo detector que market-data
    const model = isMultiOutcomeSingleMarket(markets) ? 'single-market-multi-outcome' : 'market-per-option';
    const outcomes = model === 'single-market-multi-outcome'
      ? buildOutcomesFromSingleMultiMarket(markets[0])
      : buildOutcomesFromMarketsAsOptions(markets);

    // Resolver tokenId
    let resolvedTokenId = tokenId != null ? String(tokenId) : null;
    let resolvedIndex = null;

    if (!resolvedTokenId) {
      const idx = outcomeIndex !== undefined ? parseInt(outcomeIndex, 10) : 0;
      const safeIndex = clamp(Number.isFinite(idx) ? idx : 0, 0, outcomes.length - 1);
      resolvedIndex = safeIndex;
      resolvedTokenId = outcomes[safeIndex]?.tokenId || null;
    } else {
      // encontrar índice informativo
      const found = outcomes.findIndex(o => o?.tokenId != null && String(o.tokenId) === String(resolvedTokenId));
      resolvedIndex = found >= 0 ? found : null;
    }

    // fallback mid desde el outcome seleccionado (si existe)
    let fallbackMid = 0.5;
    if (resolvedIndex != null && outcomes[resolvedIndex]) {
      fallbackMid = clamp(toNumber(outcomes[resolvedIndex].yesPrice, 0.5), 0, 1);
    }

    // CLOB best
    let bid = null, ask = null, clobRaw = null;
    if (resolvedTokenId) {
      try {
        const best = await fetchClobBest(resolvedTokenId, controller.signal);
        clobRaw = best.raw;
        bid = best.bid;
        ask = best.ask;
      } catch (e) {
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

    // volumen: en multi-outcome single market, el volumen está en markets[0]
    // en market-per-option, el volumen está en el market correspondiente (si resolvedIndex coincide)
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
      // quita esto en prod si no lo quieres
      debug: {
        usedClob: !!clobRaw,
        fallbackMid: Number(fallbackMid.toFixed(4))
      }
    };
  } finally {
    clearTimeout(timeoutId);
  }
}



