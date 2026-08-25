#!/usr/bin/env python3
"""
Jupiter Prediction Market Cross-Reference Web App
Compares the Fly.io WebSocket price feed with Jupiter's direct REST Orderbook.
"""

import asyncio
import json
import os
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Any, Optional, List
import websockets

# Configuration
DEFAULT_WS_URL = "wss://prediction-market-price-service.fly.dev/ws/prices"
JUPITER_REST_URL = "https://api.jup.ag/prediction/v1"
API_KEY = os.getenv("JUPITER_API_KEY", "")
PORT = 5050

# Shared state
state_lock = threading.Lock()
current_market_id = "BISON-FjzqDh6ymhBTEeaHMBUmt7Hu81TWiMWrodXiiSKBMYrw-UP"
active_markets: List[Dict[str, Any]] = []

latest_ws_data: Dict[str, Any] = {
    "connected": False,
    "market_id": "",
    "yes_bid": None,
    "yes_ask": None,
    "no_bid": None,
    "no_ask": None,
    "received_at": 0,
    "age_ms": None,
}

latest_rest_data: Dict[str, Any] = {
    "market_id": "",
    "yes_bid": None,
    "yes_ask": None,
    "no_bid": None,
    "no_ask": None,
    "yes_levels": [],
    "no_levels": [],
    "received_at": 0,
    "error": None,
}


def normalize_price(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return round(f / 1_000_000.0, 6) if f > 100.0 else round(f, 6)
    except (ValueError, TypeError):
        return None


def fetch_active_markets() -> List[Dict[str, Any]]:
    """Fetch live crypto events and markets from Jupiter."""
    url = f"{JUPITER_REST_URL}/events?provider=bisonfi&category=crypto&filter=live"
    headers = {"User-Agent": "Mozilla/5.0"}
    if API_KEY:
        headers["x-api-key"] = API_KEY

    try:
        req = urllib.request.Request(url, headers=headers)
        try:
            resp_ctx = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as e:
            if e.code == 401 and API_KEY:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                resp_ctx = urllib.request.urlopen(req, timeout=5)
            else:
                raise

        with resp_ctx as resp:
            data = json.loads(resp.read().decode())
            events = data if isinstance(data, list) else data.get("data", [])
            found = []
            for event in events:
                duration_tag = "5m" if "5m" in event.get("tags", []) else ("15m" if "15m" in event.get("tags", []) else "")
                title = event.get("metadata", {}).get("title", event.get("eventId", ""))
                for m in event.get("markets", []):
                    if m.get("status") == "open":
                        found.append({
                            "marketId": m["marketId"],
                            "title": f"{duration_tag} {m.get('title', '')} ({m.get('outcomeSide', '').upper()})",
                            "duration": duration_tag,
                            "side": m.get("outcomeSide", ""),
                            "eventTitle": title,
                        })
            return found
    except Exception as e:
        print(f"[Discovery Error] {e}")
        return []


def fetch_rest_orderbook(market_id: str) -> Dict[str, Any]:
    url = f"{JUPITER_REST_URL}/orderbook/{market_id}"
    headers = {"User-Agent": "Mozilla/5.0"}
    if API_KEY:
        headers["x-api-key"] = API_KEY

    try:
        req = urllib.request.Request(url, headers=headers)
        try:
            resp_ctx = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as e:
            if e.code == 401 and API_KEY:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                resp_ctx = urllib.request.urlopen(req, timeout=5)
            else:
                raise

        with resp_ctx as resp:
            data = json.loads(resp.read().decode())
            yes_raw = data.get("yes_dollars", [])
            no_raw = data.get("no_dollars", [])

            yes_levels = [{"price": float(lvl[0]), "size": float(lvl[1])} for lvl in yes_raw if len(lvl) >= 2]
            no_levels = [{"price": float(lvl[0]), "size": float(lvl[1])} for lvl in no_raw if len(lvl) >= 2]

            max_yes_bid = max([lvl["price"] for lvl in yes_levels]) if yes_levels else None
            max_no_bid = max([lvl["price"] for lvl in no_levels]) if no_levels else None

            yes_ask = round(1.0 - max_no_bid, 6) if max_no_bid is not None else None
            no_ask = round(1.0 - max_yes_bid, 6) if max_yes_bid is not None else None

            return {
                "market_id": market_id,
                "yes_bid": max_yes_bid,
                "yes_ask": yes_ask,
                "no_bid": max_no_bid,
                "no_ask": no_ask,
                "yes_levels": yes_levels[:8],
                "no_levels": no_levels[:8],
                "received_at": time.time(),
                "error": None,
            }
    except Exception as e:
        return {
            "market_id": market_id,
            "yes_bid": None,
            "yes_ask": None,
            "no_bid": None,
            "no_ask": None,
            "yes_levels": [],
            "no_levels": [],
            "received_at": time.time(),
            "error": str(e),
        }


async def ws_worker():
    """Maintain WebSocket subscription and handle dynamic market switching."""
    global latest_ws_data, current_market_id
    subscribed_market = ""

    while True:
        try:
            with state_lock:
                target_market = current_market_id
            print(f"[WebSocket] Connecting to {DEFAULT_WS_URL}...", flush=True)
            async with websockets.connect(DEFAULT_WS_URL) as ws:
                with state_lock:
                    latest_ws_data["connected"] = True
                await ws.send(json.dumps({"type": "subscribe", "marketIds": [target_market]}))
                subscribed_market = target_market
                print(f"[WebSocket] Subscribed to {target_market}", flush=True)

                while True:
                    # Check if market changed
                    with state_lock:
                        if current_market_id != subscribed_market:
                            target_market = current_market_id
                            break

                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue

                    payload = json.loads(msg)
                    if payload.get("type") == "price" and payload.get("ticker") == subscribed_market:
                        yes_bid = normalize_price(payload.get("yesBidUsd"))
                        yes_ask = normalize_price(payload.get("yesAskUsd"))
                        no_bid = normalize_price(payload.get("noBidUsd"))
                        no_ask = normalize_price(payload.get("noAskUsd"))

                        if (no_bid is None or no_bid == 0.0) and yes_ask is not None:
                            no_bid = round(1.0 - yes_ask, 6)
                        if (no_ask is None or no_ask == 0.0) and yes_bid is not None:
                            no_ask = round(1.0 - yes_bid, 6)

                        with state_lock:
                            latest_ws_data.update({
                                "connected": True,
                                "market_id": subscribed_market,
                                "yes_bid": yes_bid,
                                "yes_ask": yes_ask,
                                "no_bid": no_bid,
                                "no_ask": no_ask,
                                "received_at": time.time(),
                            })
        except Exception as e:
            with state_lock:
                latest_ws_data["connected"] = False
            print(f"[WebSocket Error] {e}. Reconnecting in 2s...", flush=True)
            await asyncio.sleep(2)


async def rest_poller():
    """Periodically fetch REST orderbook and refresh discovery markets."""
    global latest_rest_data, active_markets, current_market_id
    last_discovery = 0

    while True:
        try:
            now = time.time()
            if now - last_discovery > 15:
                markets = fetch_active_markets()
                if markets:
                    with state_lock:
                        active_markets = markets
                        if not current_market_id or current_market_id not in [m["marketId"] for m in markets]:
                            current_market_id = markets[0]["marketId"]
                last_discovery = now

            with state_lock:
                market_id = current_market_id

            if market_id:
                data = fetch_rest_orderbook(market_id)
                with state_lock:
                    if data.get("error") is None or not latest_rest_data.get("yes_levels"):
                        latest_rest_data = data
                    else:
                        latest_rest_data["error"] = data.get("error")

        except Exception as e:
            print(f"[Poller Error] {e}", flush=True)

        await asyncio.sleep(1.5)


HTML_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jupiter Prediction Orderbook Cross-Reference</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0e14;
      --card-bg: #111722;
      --card-border: #1e293b;
      --card-hover: #161f30;
      --accent-jup: #c7f284;
      --accent-poly: #00d2ff;
      --cyan: #00f0ff;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.2);
      --red: #f43f5e;
      --red-glow: rgba(244, 63, 94, 0.2);
      --amber: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Top Nav */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-badge {
      background: linear-gradient(135deg, var(--accent-jup), var(--accent-poly));
      color: #0b0e14;
      font-weight: 800;
      font-size: 14px;
      padding: 6px 12px;
      border-radius: 8px;
      letter-spacing: 0.5px;
    }

    .brand-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    .status-group {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--card-border);
      background: var(--card-bg);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    .dot.live { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .dot.warn { background: var(--amber); box-shadow: 0 0 8px var(--amber); }
    .dot.error { background: var(--red); box-shadow: 0 0 8px var(--red); }

    /* Market Selector */
    .market-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      background: var(--card-bg);
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid var(--card-border);
    }

    .market-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .market-chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      flex: 1;
    }

    .chip {
      background: #182234;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .chip:hover { border-color: var(--cyan); }
    .chip.active {
      background: linear-gradient(135deg, rgba(199, 242, 132, 0.15), rgba(0, 210, 255, 0.15));
      border-color: var(--accent-jup);
      color: var(--accent-jup);
      font-weight: 600;
    }

    /* Comparison Grid */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 1fr 240px 1fr;
      gap: 20px;
      align-items: stretch;
    }

    @media (max-width: 1100px) {
      .dashboard-grid { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      position: relative;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .feed-tag {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .feed-ws { background: rgba(0, 240, 255, 0.15); color: var(--cyan); }
    .feed-rest { background: rgba(199, 242, 132, 0.15); color: var(--accent-jup); }

    /* Price Boxes */
    .price-duo {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .price-box {
      background: #0d121c;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .price-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .price-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .val-yes { color: var(--green); }
    .val-no { color: var(--red); }

    /* Discrepancy Center Column */
    .delta-card {
      background: linear-gradient(180deg, #131a29, #0d121c);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 14px;
      text-align: center;
    }

    .delta-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .delta-item {
      background: #080c14;
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .delta-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
    }

    .delta-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 18px;
      font-weight: 700;
    }
    .delta-match { color: var(--green); }
    .delta-diff { color: var(--amber); }

    .match-banner {
      padding: 8px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .banner-perfect { background: var(--green-glow); color: var(--green); border: 1px solid var(--green); }
    .banner-mismatch { background: var(--red-glow); color: var(--amber); border: 1px solid var(--amber); }

    /* Ladder Table */
    .ladder-section {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .ladder-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .ladder-table {
      width: 100%;
      border-collapse: collapse;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }

    .ladder-table th {
      color: var(--text-dim);
      text-align: left;
      padding: 4px 6px;
      font-weight: 500;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ladder-table th.r { text-align: right; }

    .ladder-table td {
      padding: 5px 6px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .ladder-table td.r { text-align: right; }
    .ladder-yes { color: var(--green); }
    .ladder-no { color: var(--red); }

    .level-bar {
      height: 4px;
      background: rgba(16, 185, 129, 0.4);
      border-radius: 2px;
      margin-top: 2px;
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="logo-badge">JUPITER x POLYSYNC</div>
      <div class="brand-title">Prediction Orderbook Cross-Referencer</div>
    </div>
    <div class="status-group">
      <div class="pill">
        <div id="ws-dot" class="dot"></div>
        <span>Fly.io WebSocket</span>
      </div>
      <div class="pill">
        <div id="rest-dot" class="dot"></div>
        <span>Jupiter REST</span>
      </div>
      <div class="pill">
        <span id="latency-text">0ms</span>
      </div>
    </div>
  </header>

  <div class="market-bar">
    <div class="market-label">Active Markets:</div>
    <div id="market-chips" class="market-chips">
      <div class="chip active">Loading live markets...</div>
    </div>
  </div>

  <main class="dashboard-grid">
    <!-- LEFT: WebSocket Feed -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span>WebSocket Live Stream</span>
          <span class="feed-tag feed-ws">Real-Time Push</span>
        </div>
        <span id="ws-age" class="pill" style="font-size: 11px;">age: -</span>
      </div>

      <div class="price-duo">
        <div class="price-box">
          <span class="price-label">YES Best Bid</span>
          <span id="ws-yes-bid" class="price-val val-yes">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">YES Best Ask</span>
          <span id="ws-yes-ask" class="price-val val-yes">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">NO Best Bid</span>
          <span id="ws-no-bid" class="price-val val-no">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">NO Best Ask</span>
          <span id="ws-no-ask" class="price-val val-no">-</span>
        </div>
      </div>

      <div style="margin-top: auto; font-size: 11px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace;">
        Endpoint: <code>wss://prediction-market-price-service.fly.dev/ws/prices</code>
      </div>
    </div>

    <!-- CENTER: Discrepancy Matrix -->
    <div class="delta-card">
      <div class="delta-title">Live Discrepancy Matrix</div>

      <div id="match-banner" class="match-banner banner-perfect">ALIGNED</div>

      <div class="delta-item">
        <span class="delta-label">YES Bid Delta</span>
        <span id="delta-yes-bid" class="delta-value delta-match">0.0000</span>
      </div>

      <div class="delta-item">
        <span class="delta-label">YES Ask Delta</span>
        <span id="delta-yes-ask" class="delta-value delta-match">0.0000</span>
      </div>

      <div class="delta-item">
        <span class="delta-label">NO Bid Delta</span>
        <span id="delta-no-bid" class="delta-value delta-match">0.0000</span>
      </div>

      <div class="delta-item">
        <span class="delta-label">NO Ask Delta</span>
        <span id="delta-no-ask" class="delta-value delta-match">0.0000</span>
      </div>

      <div style="font-size: 11px; color: var(--text-dim);">
        Tolerance: ±0.0001
      </div>
    </div>

    <!-- RIGHT: REST Orderbook -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span>REST API Orderbook</span>
          <span class="feed-tag feed-rest">Direct REST</span>
        </div>
        <span id="rest-status" class="pill" style="font-size: 11px;">Polling 1s</span>
      </div>

      <div class="price-duo">
        <div class="price-box">
          <span class="price-label">YES Best Bid</span>
          <span id="rest-yes-bid" class="price-val val-yes">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">YES Best Ask</span>
          <span id="rest-yes-ask" class="price-val val-yes">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">NO Best Bid</span>
          <span id="rest-no-bid" class="price-val val-no">-</span>
        </div>
        <div class="price-box">
          <span class="price-label">NO Best Ask</span>
          <span id="rest-no-ask" class="price-val val-no">-</span>
        </div>
      </div>

      <div class="ladder-section">
        <div class="ladder-title">Orderbook Ladder Depth</div>
        <table class="ladder-table">
          <thead>
            <tr>
              <th>Side</th>
              <th class="r">Price ($)</th>
              <th class="r">Contracts</th>
            </tr>
          </thead>
          <tbody id="ladder-body">
            <tr><td colspan="3" style="text-align: center; color: var(--text-dim);">Loading orderbook ladder...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    let currentMarket = '';

    async function switchMarket(marketId) {
      if (currentMarket === marketId) return;
      currentMarket = marketId;
      await fetch('/api/market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId })
      });
      document.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('active', c.dataset.id === marketId);
      });
    }

    function renderMarkets(markets, activeId) {
      const container = document.getElementById('market-chips');
      if (!markets || markets.length === 0) return;
      container.innerHTML = markets.map(m => `
        <div class="chip ${m.marketId === activeId ? 'active' : ''}" data-id="${m.marketId}" onclick="switchMarket('${m.marketId}')">
          ${m.title}
        </div>
      `).join('');
    }

    function formatPrice(val) {
      if (val === null || val === undefined) return '-';
      return '$' + Number(val).toFixed(4);
    }

    function renderLadder(yesLevels, noLevels) {
      const tbody = document.getElementById('ladder-body');
      let html = '';
      (yesLevels || []).slice(0, 3).forEach(lvl => {
        html += `<tr>
          <td class="ladder-yes">YES BID</td>
          <td class="r ladder-yes">$${lvl.price.toFixed(4)}</td>
          <td class="r">${lvl.size.toFixed(2)}</td>
        </tr>`;
      });
      (noLevels || []).slice(0, 3).forEach(lvl => {
        html += `<tr>
          <td class="ladder-no">NO BID</td>
          <td class="r ladder-no">$${lvl.price.toFixed(4)}</td>
          <td class="r">${lvl.size.toFixed(2)}</td>
        </tr>`;
      });
      tbody.innerHTML = html || '<tr><td colspan="3" style="text-align:center; color: var(--text-dim);">No active orders</td></tr>';
    }

    function updateDelta(elemId, val1, val2) {
      const elem = document.getElementById(elemId);
      if (val1 === null || val1 === undefined || val2 === null || val2 === undefined) {
        elem.innerText = 'N/A';
        elem.className = 'delta-value';
        return 0;
      }
      const delta = Math.abs(val1 - val2);
      elem.innerText = delta.toFixed(4);
      const isMatch = delta < 0.0002;
      elem.className = 'delta-value ' + (isMatch ? 'delta-match' : 'delta-diff');
      return delta;
    }

    async function pollStatus() {
      const start = Date.now();
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const latency = Date.now() - start;
        document.getElementById('latency-text').innerText = latency + 'ms';

        // Dots
        document.getElementById('ws-dot').className = 'dot ' + (data.ws.connected ? 'live' : 'error');
        document.getElementById('rest-dot').className = 'dot ' + (data.rest.error ? 'error' : 'live');

        // Markets
        renderMarkets(data.active_markets, data.current_market_id);

        // WS Prices
        document.getElementById('ws-yes-bid').innerText = formatPrice(data.ws.yes_bid);
        document.getElementById('ws-yes-ask').innerText = formatPrice(data.ws.yes_ask);
        document.getElementById('ws-no-bid').innerText = formatPrice(data.ws.no_bid);
        document.getElementById('ws-no-ask').innerText = formatPrice(data.ws.no_ask);
        document.getElementById('ws-age').innerText = data.ws.age_ms !== null ? `age: ${data.ws.age_ms}ms` : 'age: -';

        // REST Prices
        document.getElementById('rest-yes-bid').innerText = formatPrice(data.rest.yes_bid);
        document.getElementById('rest-yes-ask').innerText = formatPrice(data.rest.yes_ask);
        document.getElementById('rest-no-bid').innerText = formatPrice(data.rest.no_bid);
        document.getElementById('rest-no-ask').innerText = formatPrice(data.rest.no_ask);
        document.getElementById('rest-status').innerText = data.rest.error ? 'Error' : 'REST 200 OK';

        // Delta
        const d1 = updateDelta('delta-yes-bid', data.ws.yes_bid, data.rest.yes_bid);
        const d2 = updateDelta('delta-yes-ask', data.ws.yes_ask, data.rest.yes_ask);
        const d3 = updateDelta('delta-no-bid', data.ws.no_bid, data.rest.no_bid);
        const d4 = updateDelta('delta-no-ask', data.ws.no_ask, data.rest.no_ask);

        const banner = document.getElementById('match-banner');
        if (Math.max(d1, d2, d3, d4) < 0.0002) {
          banner.className = 'match-banner banner-perfect';
          banner.innerText = 'PERFECT MATCH (ALIGNED)';
        } else {
          banner.className = 'match-banner banner-mismatch';
          banner.innerText = 'DISCREPANCY DETECTED';
        }

        // Ladder
        renderLadder(data.rest.yes_levels, data.rest.no_levels);

      } catch (e) {
        console.error(e);
      }
    }

    setInterval(pollStatus, 500);
    pollStatus();
  </script>
</body>
</html>
"""


class WebAppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode("utf-8"))
        elif self.path.startswith("/api/status"):
            with state_lock:
                ws_age = int((time.time() - latest_ws_data["received_at"]) * 1000) if latest_ws_data["received_at"] > 0 else None
                response_data = {
                    "current_market_id": current_market_id,
                    "active_markets": active_markets,
                    "ws": {
                        **latest_ws_data,
                        "age_ms": ws_age,
                    },
                    "rest": latest_rest_data,
                }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(response_data).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global current_market_id
        if self.path == "/api/market":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body.decode("utf-8"))
                new_market = data.get("marketId")
                if new_market:
                    with state_lock:
                        current_market_id = new_market
                        latest_ws_data["received_at"] = 0
                        latest_ws_data["yes_bid"] = None
                    print(f"[Web] Switched market to: {new_market}", flush=True)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress noisy HTTP request logs


def start_http_server():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), WebAppHandler)
    print(f"\n🚀 Jupiter Prediction Cross-Reference Web App started at:", flush=True)
    print(f"👉 http://localhost:{PORT}\n", flush=True)
    server.serve_forever()


async def main():
    # Start web server thread
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    # Run WebSocket listener and REST poller concurrently
    await asyncio.gather(
        ws_worker(),
        rest_poller(),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopping web app...")
