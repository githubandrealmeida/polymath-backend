# PolyMath Backend

Serverless backend for PolyMath Edge Finder using Vercel functions.

## 📋 Overview

This backend service eliminates the need for CORS proxy workarounds by handling all Polymarket API requests server-side. The frontend can now call your backend directly without CORS issues.

## 🚀 Deployment

**Live URL:** https://polymath-backend.vercel.app

**Status:** ✅ Production Ready (Deployed on Vercel)

## 📡 API Endpoints

### 1. Get Market Data

**Endpoint:** `GET /api/polymarket?type=market-data&slug=YOUR_SLUG`

**Parameters:**
- `slug` (required): Polymarket event slug (e.g., `will-bitcoin-reach-100k-by-december-31-2024`)

**Response:**
```json
{
  "success": true,
  "marketName": "Will Bitcoin reach 100k?",
  "yesTokenId": "token_id_here",
  "volume": 125000,
  "midPrice": 0.61,
  "slug": "will-bitcoin-reach-100k",
  "timestamp": "2026-01-14T22:52:44.395Z"
}
```

### 2. Get Prices (BID/ASK)

**Endpoint:** `GET /api/polymarket?type=prices&slug=YOUR_SLUG`

**Parameters:**
- `slug` (required): Polymarket event slug

**Response:**
```json
{
  "success": true,
  "bid": 0.59,
  "ask": 0.63,
  "spread": 4.0,
  "volume": 125000,
  "timestamp": "2026-01-14T22:52:44.395Z"
}
```

### 3. Health Check

**Endpoint:** `GET /api/polymarket`

**Response:**
```json
{
  "status": "ok",
  "message": "PolyMath Backend API is running",
  "timestamp": "2026-01-14T22:52:44.395Z",
  "endpoints": {
    "marketData": "/api/polymarket?type=market-data&slug=YOUR_SLUG",
    "prices": "/api/polymarket?type=prices&slug=YOUR_SLUG"
  }
}
```

## 🔄 Integration with Frontend

### Replace CORS Proxy with Backend

**Before (Old Way with CORS Proxy):**
```javascript
const proxyUrl = 'https://cors-anywhere.herokuapp.com/';
const gammaUrl = `${proxyUrl}https://gamma-api.polymarket.com/events?slug=${slug}`;
```

**After (New Way with Backend):**
```javascript
const backendUrl = 'https://polymath-backend.vercel.app/api/polymarket';

// Get market data
const marketResponse = await fetch(
  `${backendUrl}?type=market-data&slug=${slug}`
);
const marketData = await marketResponse.json();

// Get prices
const pricesResponse = await fetch(
  `${backendUrl}?type=prices&slug=${slug}`
);
const prices = await pricesResponse.json();
```

### Complete Fetch Function

```javascript
async function fetchPolymarketData(slug) {
  try {
    const backendUrl = 'https://polymath-backend.vercel.app/api/polymarket';
    
    // Fetch market data and prices in parallel
    const [marketRes, pricesRes] = await Promise.all([
      fetch(`${backendUrl}?type=market-data&slug=${slug}`),
      fetch(`${backendUrl}?type=prices&slug=${slug}`)
    ]);
    
    const marketData = await marketRes.json();
    const pricesData = await pricesRes.json();
    
    if (!marketData.success || !pricesData.success) {
      throw new Error('Failed to fetch data');
    }
    
    // Update UI with data
    document.getElementById('marketName').value = marketData.marketName;
    document.getElementById('bid').value = pricesData.bid.toFixed(4);
    document.getElementById('ask').value = pricesData.ask.toFixed(4);
    document.getElementById('volume').value = Math.round(marketData.volume);
    
    return { marketData, pricesData };
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}
```

## 🔧 Technical Details

### Architecture
- **Runtime:** Node.js on Vercel Serverless Functions
- **APIs Called:**
  - Gamma API: `gamma-api.polymarket.com` (market metadata)
  - CLOB API: `clob.polymarket.com` (order book prices)
- **CORS:** Fully enabled for frontend integration
- **Timeout:** 10 seconds per request

### Features
- ✅ Automatic CORS handling
- ✅ Error handling and fallbacks
- ✅ Response caching via Vercel
- ✅ Binary market validation
- ✅ Token ID parsing
- ✅ Spread calculation
- ✅ Orderbook fallback to Gamma prices

## 📁 Project Structure

```
polymath-backend/
├── api/
│   └── polymarket.js    # Main serverless function
├── package.json         # Project configuration
├── vercel.json         # Vercel deployment config
└── README.md          # This file
```

## 📦 Files

### `package.json`
Defines the project with proper exports and Vercel configuration.

### `vercel.json`
Configures Vercel deployment settings:
- Sets output directory to `.` (root)
- Configures serverless function at `api/polymarket.js`
- Memory allocation and timeout settings

### `api/polymarket.js`
The main serverless function that:
1. Handles CORS preflight requests
2. Routes requests by type (`market-data` or `prices`)
3. Fetches data from Polymarket APIs
4. Returns processed JSON responses

## 🔐 Security & Performance

- **CORS Headers:** Properly configured for browser access
- **Request Timeout:** 10 seconds to prevent hanging
- **Error Handling:** Graceful fallbacks and error messages
- **Deployments:** Auto-deploy on GitHub push (Vercel integration)

## 📊 Monitoring

**Vercel Dashboard:** https://vercel.com/githubandrealmeidas-projects/polymath-backend

**Metrics Available:**
- Function invocations
- Error rates
- Response times
- Edge requests

## 🎯 Next Steps

1. **Update your PolyMath HTML** to use the backend instead of CORS proxy
2. **Test the endpoints** with different market slugs
3. **Monitor performance** via Vercel dashboard
4. **Add more endpoints** as needed (e.g., historical data)

## 📝 Example Usage

```javascript
// In your PolyMath Edge Finder app
async function loadMarketData() {
  const slug = document.getElementById('marketSlug').value;
  
  try {
    const data = await fetchPolymarketData(slug);
    console.log('Market loaded:', data.marketData.marketName);
    console.log('Prices - BID:', data.pricesData.bid, 'ASK:', data.pricesData.ask);
  } catch (error) {
    console.error('Error loading market:', error);
  }
}
```

## 🚀 Performance Tips

- **Parallel Requests:** Load market data and prices simultaneously
- **Caching:** Responses are cached by Vercel's CDN
- **Compression:** Automatic gzip compression
- **Lazy Loading:** Load data only when needed

## 📞 Support

For issues or feature requests, check the Vercel deployment logs or GitHub issues.

---

**Last Updated:** January 14, 2026
**Status:** Production Ready ✅
