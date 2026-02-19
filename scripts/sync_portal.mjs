import fs from 'fs';
import path from 'path';

// 確保路徑正確
const WORKSPACE = '/home/node/.openclaw/workspace';
const SIGNALS_FILE = path.join(WORKSPACE, 'portal/signals.json');

// 模擬從資料庫或監控腳本獲取數據
// 在實際生產環境中，這裡可以讀取 database.sqlite 或 competition_log.json
async function sync() {
    console.log('Starting Portal Data Sync...');

    const data = {
        updatedAt: new Date().toISOString(),
        competition: [
            { symbol: '2330.TW', action: '加碼中', type: 'buy' },
            { symbol: 'TSLA', action: '持倉', type: 'buy' },
            { symbol: 'GOLD', action: '觀望', type: 'wait' }
        ],
        longterm: [
            { symbol: 'Spirit Fox V5', action: '運行中', type: 'buy' },
            { symbol: 'Risk Level', action: 'Normal', type: 'wait' }
        ]
    };

    try {
        fs.writeFileSync(SIGNALS_FILE, JSON.stringify(data, null, 2));
        console.log(`Successfully synced signals to ${SIGNALS_FILE}`);
    } catch (err) {
        console.error('Sync failed:', err);
    }
}

sync();
