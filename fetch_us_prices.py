#!/usr/bin/env python3
import urllib.request
import json
import sys
import os
import time

FINNHUB_API_KEY = os.environ.get('FINNHUB_API_KEY')

# Get symbols from command line args
symbols = sys.argv[1:] if len(sys.argv) > 1 else []

if not symbols:
    symbols = ['TSLA', 'NVDA', 'MSFT', 'AAPL', 'GOOGL']

results = {}

def get_json(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        if '429' in str(e):
            print(f"RATE_LIMIT", file=sys.stderr)
        return None

def fetch_finnhub_quote(symbol):
    if not FINNHUB_API_KEY:
        return None
    url = f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={FINNHUB_API_KEY}"
    data = get_json(url)
    if data and 'c' in data and data['c'] != 0:
        return {
            "price": float(data['c']),
            "change": f"{float(data.get('dp', 0)):+.2f}%",
            "pc": float(data['pc'])
        }
    return None

def fetch_finnhub_sparkline(symbol):
    if not FINNHUB_API_KEY:
        return []
    # Resolution: 60 minutes, covering last 24 hours
    end_time = int(time.time())
    start_time = end_time - (24 * 3600)
    url = f"https://finnhub.io/api/v1/stock/candle?symbol={symbol}&resolution=60&from={start_time}&to={end_time}&token={FINNHUB_API_KEY}"
    data = get_json(url)
    if data and data.get('s') == 'ok':
        return data.get('c', [])
    return []

# Mapping for special symbols
SYMBOL_MAP = {
    "NQ=F": "NDX", # Nasdaq 100 Index as proxy
    "GC=F": "GLD", # Gold ETF as proxy
    "^TWII": "EWT", # iShares Taiwan ETF as proxy
}

for sym in symbols:
    # Use map for Finnhub lookup, default to original
    lookup_sym = SYMBOL_MAP.get(sym, sym).replace('.TW', '')
    
    quote = fetch_finnhub_quote(lookup_sym)
    if quote:
        quote["sparkline"] = fetch_finnhub_sparkline(lookup_sym)
        results[sym] = quote
    else:
        results[sym] = None
    time.sleep(0.5)

print(json.dumps(results))
