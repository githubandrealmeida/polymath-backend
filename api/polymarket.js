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
        prices: '/api/polymarket?type=prices&slug=YOUR_SLUG'
      }
    });
  }
};

// Fetch market data from Gamma API
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

    // Parse token IDs
    let tokenIds;
    if (typeof market.clobTokenIds === 'string') {
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch (e) {
        tokenIds = market.clobTokenIds;
      }
    } else {
      tokenIds = market.clobTokenIds;
    }

    // Validate binary market
    if (!Array.isArray(tokenIds) || tokenIds.length !== 2) {
      return res.status(400).json({
        error: 'This market is not binary (YES/NO). App supports only 2-option markets.',
        slug: slug
      });
    }

    const yesTokenId = tokenIds[1]; // Index 1 is YES
    const marketName = market.question || eventData.title;
    const volume = parseFloat(market.volume || 0);
    const outcomePrices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
    const mid = parseFloat(outcomePrices[1]);

    return res.status(200).json({
      success: true,
      marketName,
      yesTokenId,
      volume,
      midPrice: mid,
      slug: slug,
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

// Fetch prices from CLOB API
async function fetchPrices(slug, res) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // First get market data to get token ID
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

    let tokenIds;
    if (typeof market.clobTokenIds === 'string') {
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch (e) {
        tokenIds = market.clobTokenIds;
      }
    } else {
      tokenIds = market.clobTokenIds;
    }

    if (!Array.isArray(tokenIds) || tokenIds.length !== 2) {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: 'Not a binary market'
      });
    }

    const yesTokenId = tokenIds[1];

    // Get prices from CLOB
    const bestUrl = `https://clob.polymarket.com/best?token_id=${yesTokenId}`;
    const bestResponse = await fetch(bestUrl, { signal: controller.signal });

    let bid = 0.50;
    let ask = 0.50;

    if (bestResponse.ok) {
      const bestData = await bestResponse.json();
      bid = parseFloat(bestData.best_bid || 0);
      ask = parseFloat(bestData.best_ask || 0);

      // Fallback if orderbook empty
      if (bid === 0 && ask === 0) {
        const outcomePrices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
        const mid = parseFloat(outcomePrices[1]);
        bid = mid * 0.98;
        ask = mid;
      }
    } else {
      // Fallback to Gamma prices
      const outcomePrices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
      const mid = parseFloat(outcomePrices[1]);
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
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching prices:', error);
    return res.status(500).json({
      error: error.message || 'Internal Server Error'
    });
  }
}
