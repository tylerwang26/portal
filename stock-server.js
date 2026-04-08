import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketClient } from '@fugle/marketdata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const FUGLE_API_KEY = process.env.FUGLE_API_KEY;
const VALID_TOKEN = process.env.TOKEN || 'T628_TYLER_SAFE_ACCESS';

// Token authentication middleware (DISABLED - internal service)
const authMiddleware = (req, res, next) => {
    // Internal service, allow all requests
    next();
};

// app.use(authMiddleware); // Disabled 2026-03-19

app.use(express.static(__dirname));

let signalsState = {
    updatedAt: new Date().toISOString(),
    competition: [],
    longterm: []
};

function isIndividualUSStock(symbol) {
    const usPrefixes = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', 'TSLA', 'NVDA', 'JPM', 'V', 'WMT', 'JNJ', 'PG', 'UNH', 'HD', 'MA', 'DIS', 'PYPL', 'NFLX', 'ADBE', 'CRM', 'INTC', 'VZ', 'T', 'PFE', 'MRK', 'KO', 'PEP', 'ABT', 'TMO', 'COST', 'NKE', 'MCD', 'CSCO', 'ACN', 'LIN', 'ORCL', 'DHR', 'QCOM', 'TXN', 'NEE', 'PM', 'UPS', 'HON', 'AMD', 'SBUX', 'BMY', 'UNP', 'LOW', 'SPGI', 'BLK', 'INTU', 'AMGN', 'IBM', 'CAT', 'GE', 'DE', 'BA', 'MMM', 'DIS', 'AXP', 'GS', 'MS', 'C', 'WFC', 'USB', 'TFC', 'COF', 'SCHW', 'AXP'];
    return usPrefixes.includes(symbol.toUpperCase());
}

const wsClients = {};

app.get('/api/signals', (req, res) => res.json(signalsState));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Stock-only: no /explorer route

const server = app.listen(PORT, () => {
    console.log(`[Portal Stock] Server running on port ${PORT}`);
});
