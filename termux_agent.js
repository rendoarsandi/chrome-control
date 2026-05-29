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

// --- Helper: Wake Chrome & Setup ADB Port Forwarding ---
async function wakeChromeAndForward() {
    try {
        console.error('ADB: Attempting to connect, wake Chrome, and setup port forward...');
        // Waking Chrome via adb shell monkey
        try {
            const devices = execSync('adb devices').toString().trim().split('\n').slice(1);
            const activeSerials = devices
                .map(line => line.split('\t')[0].trim())
                .filter(serial => serial.length > 0 && !serial.includes('offline'));
                
            if (activeSerials.length > 0) {
                const device = activeSerials[0];
                console.error(`ADB: Controlling device [${device}]`);
                execSync(`adb -s ${device} shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1`);
                execSync(`adb -s ${device} forward tcp:9222 localabstract:chrome_devtools_remote`);
            } else {
                console.error('ADB: No serials found in adb devices, attempting fallback loopback connection...');
                execSync('adb connect 127.0.0.1:44157').catch(() => {});
                execSync('adb forward tcp:9222 localabstract:chrome_devtools_remote');
                execSync('adb shell monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1').catch(() => {});
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
            console.error('ADB Warning: Failed to automate ADB operations:', e.message);
        }
    } catch (err) {
        console.error('ADB Error during port forward:', err.message);
    }
}

// --- Helper: Native HTTPS POST to Gemini API ---
function callGemini(apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const payload = {
            contents: [
                {
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
                        reject(new Error(`Failed to parse Gemini API JSON response: ${e.message}`));
                    }
                } else {
                    reject(new Error(`Gemini API Error (status ${res.statusCode}): ${body}`));
                }
            });
        });
        
        req.on('error', (err) => reject(err));
        req.write(data);
        req.end();
    });
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
            if (!text && el.placeholder) text = `Placeholder: ${el.placeholder}`;
            if (!text && el.value) text = `Value: ${el.value}`;
            if (!text && el.ariaLabel) text = `AriaLabel: ${el.ariaLabel}`;
            if (!text && el.title) text = `Title: ${el.title}`;
            if (!text && el.name) text = `Name: ${el.name}`;

            return {
                id: idx,
                tag: el.tagName.toLowerCase(),
                text: text || '(no label)',
                type: el.type || '',
                xpath: xpath
            };
        });
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
        // Connect over CDP
        browser = await chromium.connectOverCDP('http://localhost:9222').catch(async () => {
            await wakeChromeAndForward();
            return await chromium.connectOverCDP('http://localhost:9222');
        });

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
                
                // Clean markdown code blocks if the model ignored responseMimeType restriction
                if (responseText.startsWith('```')) {
                    responseText = responseText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
                }
                
                geminiJson = JSON.parse(responseText);
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
                    // Level-3 Fast-Path: Try direct browser-side DOM click first (0ms delay, bypasses layout occlusion)
                    const directClicked = await page.evaluate((xpath) => {
                        const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        if (el) {
                            el.click();
                            return true;
                        }
                        return false;
                    }, target.xpath);

                    if (directClicked) {
                        lastActionFeedback = `Successfully clicked element via Direct DOM Click (Fast-Path).`;
                    } else {
                        // Level-2 Fallback: Standard Playwright mouse click
                        await locator.click({ timeout: 5000 });
                        lastActionFeedback = `Successfully clicked element via standard Playwright click.`;
                    }
                } else if (geminiJson.action === 'type') {
                    // Level-3 Fast-Path: Try direct DOM value assignment & input dispatch (Fast & Accurate)
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
                        lastActionFeedback = `Successfully filled text via Direct DOM Input (Fast-Path).`;
                    } else {
                        // Level-2 Fallback: Standard Playwright keyboard typing simulation
                        await locator.focus();
                        await locator.fill('');
                        for (const char of geminiJson.value) {
                            await page.keyboard.type(char, { delay: 40 + Math.random() * 50 });
                        }
                        lastActionFeedback = `Successfully filled text via standard keyboard typing simulation.`;
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
