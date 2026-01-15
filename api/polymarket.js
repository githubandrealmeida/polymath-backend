// Serverless function for PolyMath backend
// Handles Polymarket API requests with CORS enabled

export default async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Extract slug from query params
  const { slug, type } = req.query;

  // Route different requests
  if (type === 'market-data' && slug) {
    return fetchMarketData(slug, res);
  } else if (type === 'prices' && slug) {
    return fetchPrices(slug, res);
  } else {
    // Default response
    return res.status(200).json({
      status: 'ok',
      message: 'PolyMath Backend API is running',
      timestamp: new Date().toISOString(),
      endpoints: {
        marketData: '/api/polymarket?type=market-data&slug=YOUR_SLUG',
        prices: '/api/polymarket?type=prices&slug=YOUR_SLUG&outcomeIndex=0'
      }
    });
  }
};

// ========== MARKET DATA: recorre eventData.markets ==========
async function fetchMarketData(slug, res) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const gammaUrl = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
    const gammaResponse = await fetch(gammaUrl, { signal: controller.signal });

    if (!gammaResponse.ok) {
      clearTimeout(timeoutId);
      return res.status(gammaResponse.status).json({
        error: `Gamma API error: ${gammaResponse.status}`,
        slug
      });
    }

    const events = await gammaResponse.json();
    clearTimeout(timeoutId);

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(404).json({
        error: `Market "${slug}" not found`,
        slug
      });
    }

    const eventData = events[0];
    const markets = Array.isArray(eventData.markets) ? eventData.markets : [];

    if (markets.length === 0) {
      return res.status(404).json({
        error: 'No active markets for this event',
        slug
      });
    }

    const eventTitle = eventData.title || 'Polymarket Event';
    const outcomes = [];
    let totalVolume = 0;

    markets.forEach((m, idx) => {
      totalVolume += parseFloat(m.volume || 0);

      // outcomePrices de ese market (normalmente [NO, YES] o [0,1])
      let prices = [];
      try {
        prices = JSON.parse(m.outcomePrices || '[]');
      } catch (e) {
        prices = [];
      }

      // Heurística: si hay al menos 2 precios, cogemos el segundo como YES; si no, el primero
      const yesPrice = prices.length >= 2
        ? parseFloat(prices[1])
        : parseFloat(prices[0] || '0.5');

      // nombres: usamos m.question como nombre principal
      const name = m.question || `Market ${idx + 1}`;

      // clobTokenIds por market
      let tokenIds = m.clobTokenIds;
      if (typeof tokenIds === 'string') {
        try {
          tokenIds = JSON.parse(tokenIds);
        } catch (e) {
          // lo dejamos tal cual
        }
      }

      // Heurística: tokenId asociado al YES de ese market (segundo si hay 2, si no primero)
      let tokenId = null;
      if (Array.isArray(tokenIds) && tokenIds.length > 0) {
        tokenId = tokenIds.length >= 2 ? tokenIds[1] : tokenIds[0];
      }

      outcomes.push({
        index: idx,        // índice del market dentro de eventData.markets
        name,              // pregunta/descripcion del candidato
        yesPrice: isNaN(yesPrice) ? 0.5 : yesPrice,
        tokenId
      });
    });

    // midPrice: tomamos el YES del outcome "favorito" (mayor yesPrice)
    const bestOutcome = outcomes.reduce(
      (prev, curr) => (prev.yesPrice > curr.yesPrice ? prev : curr),
      outcomes[0]
    );
    const midPrice = bestOutcome ? bestOutcome.yesPrice : 0.5;

    return res.status(200).json({
      success: true,
      marketName: eventTitle,
      volume: totalVolume,
      slug,
      midPrice,
      outcomes, // lista de "candidatos" = markets del evento
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching market data:', error);
    return res.status(500).json({
      error: error.message || 'Internal Server Error',
      slug
    });
  }
}

// ========== PRICES: usa eventData.markets[outcomeIndex] ==========
async function fetchPrices(slug, res) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // outcomeIndex opcional; por defecto 0 (primer market)
    const outcomeIndexParam = res.req.query.outcomeIndex;
    const outcomeIndex =
      outcomeIndexParam !== undefined ? parseInt(outcomeIndexParam, 10) : 0;

    const gammaUrl = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
    const gammaResponse = await fetch(gammaUrl, { signal: controller.signal });

    if (!gammaResponse.ok) {
      clearTimeout(timeoutId);
      return res.status(gammaResponse.status).json({
        error: `Gamma API error: ${gammaResponse.status}`
      });
    }

    const events = await gammaResponse.json();
    const eventData = events[0];
    const markets = Array.isArray(eventData?.markets) ? eventData.markets : [];

    if (markets.length === 0) {
      clearTimeout(timeoutId);
      return res.status(404).json({
        error: 'Market not found'
      });
    }

    // Aseguramos índice válido de market
    const safeIndex = Math.min(Math.max(0, outcomeIndex), markets.length - 1);
    const market = markets[safeIndex];

    // outcomePrices del market elegido
    let prices = [];
    try {
      prices = JSON.parse(market.outcomePrices || '[]');
    } catch (e) {
      prices = [];
    }

    // clobTokenIds del market elegido
    let tokenIds = market.clobTokenIds;
    if (typeof tokenIds === 'string') {
      try {
        tokenIds = JSON.parse(tokenIds);
      } catch (e) {
        // lo dejamos
      }
    }

    // Heurística YES token: segundo si hay 2, si no primero
    let yesTokenId = null;
    if (Array.isArray(tokenIds) && tokenIds.length > 0) {
      yesTokenId = tokenIds.length >= 2 ? tokenIds[1] : tokenIds[0];
    }

    let bid = 0.5;
    let ask = 0.5;

    // Intentamos libro de órdenes CLOB
    if (yesTokenId) {
      const bestUrl = `https://clob.polymarket.com/best?token_id=${yesTokenId}`;
      const bestResponse = await fetch(bestUrl, { signal: controller.signal });

      if (bestResponse.ok) {
        const bestData = await bestResponse.json();
        bid = parseFloat(bestData.best_bid || 0);
        ask = parseFloat(bestData.best_ask || 0);
      }
    }

    // Si no hay órdenes, usamos outcomePrices como mid
    if (bid === 0 && ask === 0) {
      let mid = 0.5;
      if (prices.length >= 2) {
        mid = parseFloat(prices[1] || '0.5');
      } else if (prices.length === 1) {
        mid = parseFloat(prices[0] || '0.5');
      }
      if (isNaN(mid)) mid = 0.5;
      bid = mid * 0.98;
      ask = mid;
    }

    // Ensure logical spread
    if (bid >= ask) {
      bid = ask * 0.98;
    }

    clearTimeout(timeoutId);

    return res.status(200).json({
      success: true,
      bid: parseFloat(bid.toFixed(4)),
      ask: parseFloat(ask.toFixed(4)),
      spread: parseFloat(((ask - bid) * 100).toFixed(2)),
      volume: market.volume || 0,
      outcomeIndex: safeIndex,
      tokenId: yesTokenId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching prices:', error);
    return res.status(500).json({
      error: error.message || 'Internal Server Error'
    });
  }
}


