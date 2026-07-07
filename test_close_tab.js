Object.defineProperty(process, 'platform', { value: 'linux' });
const http = require('http');
const { chromium } = require('playwright-core');

function makeRequest(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve(body);
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        console.log("Creating a clean, new Google tab...");
        const newTab = await makeRequest('http://localhost:9222/json/new?url=https://www.google.com');
        console.log(`Created new tab with ID: ${newTab.id}`);
        
        console.log("Fetching active tabs...");
        const tabs = await makeRequest('http://localhost:9222/json/list');
        console.log(`Found ${tabs.length} tabs.`);
        
        // Close all other tabs except the new Google tab
        for (const tab of tabs) {
            if (tab.id !== newTab.id && (tab.type === 'page' || tab.type === 'worker')) {
                console.log(`Closing tab/worker ID: ${tab.id} (${tab.title || 'Untitled'})`);
                await makeRequest(`http://localhost:9222/json/close/${tab.id}`);
            }
        }
        
        console.log("Waiting for tabs to settle...");
        await new Promise(r => setTimeout(r, 2000));
        
        console.log("Connecting to browser via connectOverCDP...");
        const browser = await chromium.connectOverCDP('http://localhost:9222');
        console.log("SUCCESSFULLY connected to browser!");
        
        const contexts = browser.contexts();
        console.log(`Contexts: ${contexts.length}`);
        const pages = contexts[0].pages();
        console.log(`Pages inside context: ${pages.length}`);
        for (const page of pages) {
            console.log(`- Page: "${await page.title()}" (${page.url()})`);
        }
        
        await browser.close();
    } catch (err) {
        console.error("CDP connection failed:", err.message);
    }
}

run();
