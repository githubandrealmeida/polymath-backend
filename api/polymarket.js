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

// Fetch market data from Gamma API (TODOS los outcomes)
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
        slug: slug
      });
    }

    const events = await gammaResponse.json();
    clearTimeout(timeoutId);

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(404).json({
        error: `Market "${slug}" not found`,
        slug: slug
      });
    }

    const eventData = events[0];
    const market = eventData.markets?.[0];

    if (!market) {
      return res.status(404).json({
        error: 'No active markets for this event',
        slug: slug
      });
    }

    const marketName = market.question || eventData.title;
    const volume = parseFloat(market.volume || 0);

    // outcomePrices = array de strings con precios YES por outcome
    let outcomePrices = [];
    try {
      outcomePrices = JSON.parse(market.outcomePrices || '[]');
    } catch (e) {
      outcomePrices = [];
    }

    // Metadatos de outcomes si están disponibles
    const outcomesMeta = market.outcomes || market.outcomeTokens || [];

    // clobTokenIds puede ser string JSON o array
    let tokenIdsRaw = market.clobTokenIds;
    if (typeof tokenIdsRaw === 'string') {
      try {
        tokenIdsRaw = JSON.parse(tokenIdsRaw);
      } catch (e) {
        // lo dejamos tal cual
      }
    }

    const outcomes = [];

    if (Array.isArray(outcomePrices) && outcomePrices.length > 0) {
      for (let i = 0; i < outcomePrices.length; i++) {
        const yesPrice = parseFloat(outcomePrices[i]);
        const meta = outcomesMeta[i] || {};
        const name = meta.name || meta.ticker || `Outcome ${i + 1}`;
        const tokenId = Array.isArray(tokenIdsRaw) ? tokenIdsRaw[i] : null;

        outcomes.push({
          index: i,
          name,
          yesPrice,
          tokenId
        });
      }
    }

    // midPrice por defecto: outcome 1 si existe, si no outcome 0, si no 0.5
    const mid =
      outcomes[1]?.yesPrice ??
      outcomes[0]?.yesPrice ??
      0.5;

    return res.status(200).json({
      success: true,
      marketName,
      volume,
      slug,
      midPrice: mid,
      outcomes, // lista de candidatos/outcomes
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching market data:', error);
    return res.status(500).json({
      error: error.message || 'Internal Server Error',
      slug: slug
    });
  }
}

// Fetch prices from CLOB API (outcome concreto)
async function fetchPrices(slug, res) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // outcomeIndex opcional; por defecto 1 (segundo outcome), para no romper lo viejo
    const outcomeIndexParam = res.req.query.outcomeIndex;
    const outcomeIndex =
      outcomeIndexParam !== undefined ? parseInt(outcomeIndexParam, 10) : 1;

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
    const market = eventData?.markets?.[0];

    if (!market) {
      clearTimeout(timeoutId);
      return res.status(404).json({
        error: 'Market not found'
      });
    }

    let outcomePrices = [];
    try {
      outcomePrices = JSON.parse(market.outcomePrices || '[]');
    } catch (e) {
      outcomePrices = [];
    }

    let tokenIds = market.clobTokenIds;
    if (typeof tokenIds === 'string') {
      try {
        tokenIds = JSON.parse(tokenIds);
      } catch (e) {
        // lo dejamos
      }
    }

    if (!Array.isArray(outcomePrices) || outcomePrices.length === 0) {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: 'No outcome prices available for this market'
      });
    }

    // Aseguramos índice válido
    const safeIndex = Math.min(Math.max(0, outcomeIndex), outcomePrices.length - 1);

    const yesTokenId = Array.isArray(tokenIds) ? tokenIds[safeIndex] : null;

    let bid = 0.5;
    let ask = 0.5;

    if (yesTokenId) {
      const bestUrl = `https://clob.polymarket.com/best?token_id=${yesTokenId}`;
      const bestResponse = await fetch(bestUrl, { signal: controller.signal });

      if (bestResponse.ok) {
        const bestData = await bestResponse.json();
        bid = parseFloat(bestData.best_bid || 0);
        ask = parseFloat(bestData.best_ask || 0);
      }
    }

    // Si no hay libro o no hay tokenId, usamos outcomePrices como mid
    if (bid === 0 && ask === 0) {
      const mid = parseFloat(outcomePrices[safeIndex] || '0.5');
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

