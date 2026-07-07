Object.defineProperty(process, 'platform', { value: 'linux' });
const http = require('http');
const { chromium } = require('playwright-core');

function getTabs() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json/list', (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        console.log("Fetching active tabs...");
        const tabs = await getTabs();
        console.log(`Found ${tabs.length} tabs.`);
        
        // Find the first tab with a valid non-empty URL
        const validTab = tabs.find(tab => tab.type === 'page' && tab.url && tab.webSocketDebuggerUrl);
        if (!validTab) {
            console.error("No valid non-empty tabs found!");
            return;
        }
        
        console.log(`Connecting directly to tab: "${validTab.title}" (${validTab.url})`);
        console.log(`WebSocket URL: ${validTab.webSocketDebuggerUrl}`);
        
        const browser = await chromium.connectOverCDP(validTab.webSocketDebuggerUrl);
        console.log("SUCCESSFULLY connected direct to CDP!");
        
        const contexts = browser.contexts();
        console.log(`Contexts: ${contexts.length}`);
        const pages = contexts[0].pages();
        console.log(`Pages inside context: ${pages.length}`);
        
        const activePage = pages[0];
        console.log(`Active page title: "${await activePage.title()}"`);
        
        await browser.close();
    } catch (err) {
        console.error("CDP direct connection failed:", err.message);
    }
}

run();
