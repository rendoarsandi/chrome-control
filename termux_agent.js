#!/usr/bin/env node

/**
 * termux_agent.js
 * 
 * A lightweight, zero-compilation, crash-proof browser automation agent
 * tailored for memory-constrained Termux / Android environments.
 * 
 * Uses playwright-core to control Android Chrome over CDP (Port 9222)
 * and the Gemini API for semantic, self-healing browser intelligence.
 */

Object.defineProperty(process, 'platform', { value: 'linux' });
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

// --- Helper: Wake Chrome & Setup ADB Port Forwarding ---
async function wakeChromeAndForward() {
    try {
        console.error('ADB: Attempting to connect, wake Chrome, and setup port forward...');
        // Waking Chrome via adb shell monkey
        try {
            const devices = execSync('adb devices').toString().trim().split('\n').slice(1);
            const activeSerials = devices
                .filter(line => line.includes('\tdevice') || line.endsWith('\tdevice'))
                .map(line => line.split('\t')[0].trim())
                .filter(serial => serial.length > 0);
                
            if (activeSerials.length > 0) {
                const device = activeSerials[0];
                console.error(`ADB: Controlling device [${device}]`);
                execSync(`adb -s ${device} shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1`);
                execSync(`adb -s ${device} forward tcp:9222 localabstract:chrome_devtools_remote`);
            } else {
                console.error('ADB: No serials found in adb devices, attempting fallback loopback connection...');
                try {
                    execSync('adb connect 127.0.0.1:44157');
                } catch (e) {}
                try {
                    execSync('adb forward tcp:9222 localabstract:chrome_devtools_remote');
                } catch (e) {}
                try {
                    execSync('adb shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1');
                } catch (e) {}
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
            console.error('ADB Warning: Failed to automate ADB operations:', e.message);
        }
    } catch (err) {
        console.error('ADB Error during port forward:', err.message);
    }
}

// --- Helper: Native HTTPS POST to Gemini API / Vertex AI ---
function callGemini(apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
        let url;
        const isVertex = apiKey.startsWith('AQ.') || process.env.VERTEX_PROJECT_ID;
        
        let targetModel = model;
        if (isVertex) {
            const project = process.env.VERTEX_PROJECT_ID || 'gen-lang-client-0471281580';
            let location = process.env.VERTEX_LOCATION;
            if (!location) {
                if (targetModel.includes('3.5')) {
                    location = 'global';
                } else {
                    location = 'us-central1';
                }
            }
            const domain = location === 'global' ? 'aiplatform.googleapis.com' : (location === 'us' ? 'aiplatform.us.rep.googleapis.com' : `${location}-aiplatform.googleapis.com`);
            url = `https://${domain}/v1/projects/${project}/locations/${location}/publishers/google/models/${targetModel}:generateContent?key=${apiKey}`;
            console.error(`[Vertex AI] Using Model: ${targetModel}, Region: ${location}, Project: ${project}, Domain: ${domain}`);
        } else {
            url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
        }
        
        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: prompt }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        const data = JSON.stringify(payload);
        
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Failed to parse API JSON response: ${e.message}`));
                    }
                } else {
                    reject(new Error(`API Error (status ${res.statusCode}): ${body}`));
                }
            });
        });
        
        req.on('error', (err) => reject(err));
        req.write(data);
        req.end();
    });
}

// --- Helper: Robustly Extract JSON block from response text ---
function extractJSON(text) {
    if (!text) return null;
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
        const jsonContent = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(jsonContent);
    }
    return JSON.parse(text);
}

// --- Browser DOM Extractor (Injected Client-Side) ---
function getInteractiveElements() {
    // Standard absolute XPath builder
    function getElementXPath(element) {
        if (element.id) return `//*[@id="${element.id}"]`;
        const paths = [];
        for (; element && element.nodeType === 1; element = element.parentNode) {
            let index = 0;
            for (let sibling = element.previousSibling; sibling; sibling = sibling.previousSibling) {
                if (sibling.nodeType === Node.DOCUMENT_TYPE_NODE) continue;
                if (sibling.nodeName === element.nodeName) ++index;
            }
            const tagName = element.nodeName.toLowerCase();
            const pathIndex = (index ? `[${index + 1}]` : '');
            paths.unshift(`${tagName}${pathIndex}`);
        }
        return paths.length ? `/${paths.join('/')}` : null;
    }

    const interactiveTags = ['button', 'input', 'select', 'textarea', 'a', '[role="button"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]'];
    const elements = Array.from(document.querySelectorAll(interactiveTags.join(', ')));
    
    return elements
        .filter(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && 
                   rect.height > 0 && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0';
        })
        .map((el, idx) => {
            const xpath = getElementXPath(el);
            
            // Extract descriptive text / label
            let text = el.innerText.trim();
            if (!text) {
                // If there's an image inside, check its alt text
                const img = el.querySelector('img');
                if (img && img.alt) {
                    text = img.alt.trim();
                }
            }
            if (!text && el.placeholder) text = `Placeholder: ${el.placeholder}`;
            if (!text && el.value) text = `Value: ${el.value}`;
            if (!text && el.ariaLabel) text = `AriaLabel: ${el.ariaLabel}`;
            if (!text && el.title) text = `Title: ${el.title}`;
            if (!text && el.name) text = `Name: ${el.name}`;
            if (!text && el.getAttribute('alt')) text = `Alt: ${el.getAttribute('alt')}`;

            return {
                id: idx,
                tag: el.tagName.toLowerCase(),
                text: text || '(no label)',
                type: el.type || '',
                xpath: xpath
            };
        });
}

function httpGet(url) {
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

async function sanitizeAndConnect(navigateUrl) {
    // 1. Ensure ADB port forwarding is configured
    await wakeChromeAndForward();
    
    // 2. Open the target page directly via ADB intent to bring Chrome to front cleanly
    const targetUrl = navigateUrl || "https://www.google.com";
    try {
        const devices = execSync('adb devices').toString().trim().split('\n').slice(1);
        const activeSerials = devices
            .filter(line => line.includes('\tdevice') || line.endsWith('\tdevice'))
            .map(line => line.split('\t')[0].trim())
            .filter(serial => serial.length > 0);
            
        if (activeSerials.length > 0) {
            const device = activeSerials[0];
            console.error(`ADB: Clean opening URL ${targetUrl} on device [${device}]`);
            execSync(`adb -s ${device} shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -d "${targetUrl}"`);
        } else {
            console.error(`ADB: Fallback opening URL ${targetUrl}`);
            execSync(`adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -d "${targetUrl}"`);
        }
    } catch (e) {
        console.error(`ADB intent startup warning: ${e.message}`);
    }
    
    // Settle wait
    await new Promise(r => setTimeout(r, 3000));
    
    // 3. Force-close other active tabs or service workers to prevent Playwright targets discovery from hanging
    try {
        const tabs = await httpGet('http://localhost:9222/json/list');
        if (Array.isArray(tabs) && tabs.length > 0) {
            console.error(`CDP Sanitizer: Found ${tabs.length} open targets. Isolating active workspace...`);
            
            // Resolve keeping target
            let keepTab = tabs.find(tab => tab.type === 'page' && tab.url && (tab.url.toLowerCase().includes('google.com') || (navigateUrl && tab.url.toLowerCase().includes(navigateUrl.toLowerCase().split('/')[2]))));
            if (!keepTab) {
                keepTab = tabs.find(tab => tab.type === 'page' && tab.url);
            }
            
            if (keepTab) {
                console.error(`CDP Sanitizer: Preserving active target ID ${keepTab.id} (${keepTab.title})`);
                for (const tab of tabs) {
                    if (tab.id !== keepTab.id && (tab.type === 'page' || tab.type === 'worker')) {
                        console.error(`CDP Sanitizer: Terminating background target ID ${tab.id} (${tab.title || 'Untitled'})`);
                        await httpGet(`http://localhost:9222/json/close/${tab.id}`).catch(() => {});
                    }
                }
            }
        }
    } catch (e) {
        console.error(`CDP Sanitizer warning: Tab sanitation bypassed: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
    
    // 4. Connect Playwright cleanly
    console.error("CDP: Initializing Playwright CDP Handshake...");
    return await chromium.connectOverCDP('http://localhost:9222');
}

// --- Main Agent Loop ---
async function runAgent(task, urlKeyword, navigateUrl) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('\nError: GEMINI_API_KEY environment variable is not set!');
        console.error('Please configure it in your terminal:');
        console.error('  export GEMINI_API_KEY="your-gemini-api-key"\n');
        process.exit(1);
    }

    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    console.log(`Starting Termux Browser Agent...`);
    console.log(`Task: "${task}"`);
    console.log(`Model: ${model}\n`);

    let browser;
    try {
        // Connect over CDP with sanitation
        browser = await sanitizeAndConnect(navigateUrl);

        const contexts = browser.contexts();
        if (contexts.length === 0) throw new Error("No active browser contexts found.");

        const pages = contexts[0].pages();
        if (pages.length === 0) throw new Error("No active browser tabs found.");

        // Resolve target tab
        let page = pages[0];
        if (urlKeyword) {
            const kw = urlKeyword.toLowerCase();
            for (const p of pages) {
                const u = p.url().toLowerCase();
                const t = (await p.title()).toLowerCase();
                if (u.includes(kw) || t.includes(kw)) {
                    page = p;
                    break;
                }
            }
        }

        console.log(`Connected to active browser tab: "${await page.title()}"`);

        if (navigateUrl) {
            console.log(`Navigating to target URL: ${navigateUrl}`);
            await page.goto(navigateUrl, { waitUntil: 'load' });
            await new Promise(r => setTimeout(r, 2000));
        }

        let step = 1;
        const maxSteps = 20;
        let lastActionFeedback = "";

        while (step <= maxSteps) {
            console.log(`\n================ STEP ${step} ================`);
            const currentUrl = page.url();
            const currentTitle = await page.title();
            console.log(`Current URL: ${currentUrl}`);
            console.log(`Current Title: "${currentTitle}"`);

            // Extract visible interactive elements
            const elements = await page.evaluate(getInteractiveElements);
            console.log(`Extracted ${elements.length} visible interactive elements.`);

            if (elements.length === 0) {
                console.log("No interactive elements found on the screen. Waiting for load...");
                await new Promise(r => setTimeout(r, 3000));
                step++;
                continue;
            }

            // Build Prompt for Gemini
            const elementsText = JSON.stringify(elements, null, 2);
            const prompt = `You are an agentic web browser controller operating on Android Chrome.
Your high-level objective is: "${task}"

Current Page URL: "${currentUrl}"
Current Tab Title: "${currentTitle}"

${lastActionFeedback ? `Feedback from last action: ${lastActionFeedback}\n` : ''}

Here are the interactive elements currently visible on the active page viewport:
\`\`\`json
${elementsText}
\`\`\`

Based on the objective and active elements, determine the NEXT single action to execute.
To answer surveys or quizzes, use the general context of the page or any provided context.

Respond ONLY with a valid raw JSON object matching this schema (no markdown formatting, no code block tick marks):
{
  "reasoning": "Explain in 1 sentence your decision and target chosen",
  "action": "click" | "type" | "select" | "finish",
  "target_id": 4, // The numerical ID of the chosen element
  "value": "string value to type or select (if applicable)"
}
`;

            let geminiJson;
            try {
                console.log("Querying Gemini API for next step...");
                const response = await callGemini(apiKey, model, prompt);
                let responseText = response.candidates[0].content.parts[0].text.trim();
                geminiJson = extractJSON(responseText);
            } catch (e) {
                console.error("Gemini Response parsing failure. Raw text returned:", e.message);
                lastActionFeedback = `Failed to get a valid JSON plan from the LLM. Error: ${e.message}. Retrying...`;
                await new Promise(r => setTimeout(r, 2000));
                step++;
                continue;
            }

            console.log(`Decision: "${geminiJson.reasoning}"`);
            console.log(`Action:  [${geminiJson.action}] on ID ${geminiJson.target_id} ${geminiJson.value ? `with value "${geminiJson.value}"` : ''}`);

            if (geminiJson.action === 'finish') {
                console.log("\nGoal completed successfully according to the Agent!");
                break;
            }

            // Resolve target element in current list
            const target = elements.find(el => el.id === geminiJson.target_id);
            if (!target) {
                lastActionFeedback = `Action failed: Target ID ${geminiJson.target_id} is no longer in the active elements list. Keep in mind layout shifts or page updates.`;
                console.warn(lastActionFeedback);
                await new Promise(r => setTimeout(r, 2000));
                step++;
                continue;
            }

            try {
                const locator = page.locator(`xpath=${target.xpath}`).first();
                await locator.scrollIntoViewIfNeeded();

                // Human-like random delay
                await new Promise(r => setTimeout(r, 300 + Math.random() * 300));

                if (geminiJson.action === 'click') {
                    let clicked = false;

                    // Tier 1: Standard Playwright click (simulates actual human events, triggers framework listeners)
                    try {
                        await locator.click({ timeout: 2000 });
                        lastActionFeedback = `Successfully clicked element via standard Playwright click.`;
                        clicked = true;
                    } catch (err) {
                        console.warn(`Standard click failed (ID: ${geminiJson.target_id}): ${err.message}. Trying Tier 2 mouse click...`);
                    }

                    // Tier 2: Mouse center-point coordinates click (bypasses layout occlusions/overlays)
                    if (!clicked) {
                        try {
                            const box = await locator.boundingBox();
                            if (box) {
                                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                                lastActionFeedback = `Successfully clicked element via Mouse Coordinates click (Tier 2).`;
                                clicked = true;
                            } else {
                                console.warn(`Element bounding box is null (ID: ${geminiJson.target_id}).`);
                            }
                        } catch (err) {
                            console.warn(`Mouse coordinate click failed (ID: ${geminiJson.target_id}): ${err.message}. Trying Tier 3 Direct DOM click...`);
                        }
                    }

                    // Tier 3: Direct JS DOM element.click() fallback (forces execution even if hidden/covered)
                    if (!clicked) {
                        const directClicked = await page.evaluate((xpath) => {
                            const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                            if (el) {
                                el.click();
                                return true;
                            }
                            return false;
                        }, target.xpath);

                        if (directClicked) {
                            lastActionFeedback = `Successfully clicked element via Direct DOM Click fallback (Tier 3).`;
                            clicked = true;
                        } else {
                            throw new Error("Element could not be resolved in DOM for Direct Click.");
                        }
                    }
                } else if (geminiJson.action === 'type') {
                    let typed = false;

                    // Tier 1: Standard Playwright fill/typing (triggers React/Vue virtual DOM updates)
                    try {
                        await locator.focus();
                        await locator.fill('', { timeout: 2000 });
                        for (const char of geminiJson.value) {
                            await page.keyboard.type(char, { delay: 30 + Math.random() * 40 });
                        }
                        lastActionFeedback = `Successfully filled text via standard keyboard typing simulation.`;
                        typed = true;
                    } catch (err) {
                        console.warn(`Standard typing failed (ID: ${geminiJson.target_id}): ${err.message}. Trying Tier 2 Direct DOM Input...`);
                    }

                    // Tier 2: Direct DOM value assignment & input dispatch (Fast & Accurate fallback)
                    if (!typed) {
                        const directTyped = await page.evaluate(({ xpath, value }) => {
                            const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                            if (el) {
                                el.focus();
                                el.value = value;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                return true;
                            }
                            return false;
                        }, { xpath: target.xpath, value: geminiJson.value });

                        if (directTyped) {
                            lastActionFeedback = `Successfully filled text via Direct DOM Input fallback (Tier 2).`;
                            typed = true;
                        } else {
                            throw new Error("Element could not be resolved in DOM for Direct Input assignment.");
                        }
                    }
                } else if (geminiJson.action === 'select') {
                    await locator.selectOption(geminiJson.value);
                    lastActionFeedback = `Successfully selected option "${geminiJson.value}" in dropdown.`;
                }
                
                console.log(lastActionFeedback);
            } catch (err) {
                lastActionFeedback = `Action failed on element (ID: ${geminiJson.target_id}): ${err.message}. Choose another target or try scrolling/waiting.`;
                console.error(lastActionFeedback);
            }

            // Page stabilization wait
            await new Promise(r => setTimeout(r, 2000));
            step++;
        }

    } catch (err) {
        console.error("Agent Execution Error:", err.message);
        process.exit(1);
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

// --- CLI Runner Parsing ---
const args = process.argv.slice(2);
let task = null;
let urlKeyword = 'testio';
let navigateUrl = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task' || args[i] === '-t') {
        task = args[++i];
    } else if (args[i] === '--url-keyword' || args[i] === '-k') {
        urlKeyword = args[++i];
    } else if (args[i] === '--navigate' || args[i] === '-n') {
        navigateUrl = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
        console.log(`
Lightweight Agentic Browser CLI for Termux

Options:
  --task, -t <TASK>          Task description for the agent to achieve (Required)
  --url-keyword, -k <KW>     Keyword to match active Chrome tab (default: 'testio')
  --navigate, -n <URL>       URL to navigate to at start
  --help, -h                 Print this help guide
`);
        process.exit(0);
    }
}

if (!task) {
    console.error("Error: --task option is required!");
    console.error("Example: node termux_agent.js --task \"Complete the onboarding feedback survey\"");
    process.exit(1);
}

runAgent(task, urlKeyword, navigateUrl);
