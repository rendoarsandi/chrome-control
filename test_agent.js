#!/usr/bin/env node

/**
 * test_agent.js
 * 
 * Unit and integration test suite to verify the DOM simplifier
 * and action locator logic of termux_agent.js on active Android Chrome.
 */

Object.defineProperty(process, 'platform', { value: 'linux' });
const { chromium } = require('playwright-core');
const assert = require('assert');

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

// Ported getInteractiveElements function from termux_agent.js for verification
function getInteractiveElements() {
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
            paths.unshift(tagName + pathIndex);
        }
        return paths.length ? '/' + paths.join('/') : null;
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
            let text = el.innerText.trim();
            if (!text) {
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

async function runTests() {
    console.log("Starting Termux Browser Agent Unit Tests...");
    
    // Test extractJSON robustness
    console.log("Verifying JSON parser robustness...");
    
    const validJSONText = '{"reasoning": "clicking", "action": "click", "target_id": 1}';
    const json1 = extractJSON(validJSONText);
    assert.strictEqual(json1.action, "click");
    
    const markdownJSONText = '```json\n{"reasoning": "clicking", "action": "click", "target_id": 1}\n```';
    const json2 = extractJSON(markdownJSONText);
    assert.strictEqual(json2.action, "click");
    
    const conversationalText = 'Sure! Here is the JSON:\n```json\n{"reasoning": "typing", "action": "type", "target_id": 2, "value": "test"}\n```\nHope that helps!';
    const json3 = extractJSON(conversationalText);
    assert.strictEqual(json3.action, "type");
    assert.strictEqual(json3.value, "test");
    
    console.log("✔ JSON PARSER ROBUSTNESS TESTS PASSED!");

    let browser;
    let tempPage;

    try {
        console.log("Connecting to Android Chrome over CDP (127.0.0.1:9222)...");
        browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const context = browser.contexts()[0];
        
        console.log("Opening a new test tab...");
        tempPage = await context.newPage();
        
        console.log("Loading mock interactive HTML page into sandbox...");
        const mockHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .hidden-el { display: none; }
                    .invisible-el { visibility: hidden; }
                    .zero-opacity { opacity: 0; }
                </style>
            </head>
            <body>
                <h1>Mock Sandbox</h1>
                <!-- Interactive Elements (Should be extracted) -->
                <button id="btn1">Click Me</button>
                <input id="inp1" type="text" placeholder="Enter name">
                <a id="link1" href="#">Read More</a>
                
                <!-- Enhanced label/alt detection elements -->
                <button id="btn-img"><img src="icon.png" alt="Close Modal"></button>
                <a id="link-alt" href="#" alt="External Link"></a>

                <!-- Hidden/Non-interactive Elements (Should be ignored) -->
                <div id="div1">Static Text</div>
                <button id="btn-hidden" class="hidden-el">Invisible Button</button>
                <input id="inp-invisible" class="invisible-el" type="text" value="Secret">
                <a id="link-transparent" class="zero-opacity" href="#">Ghost Link</a>
            </body>
            </html>
        `;
        
        await tempPage.setContent(mockHTML);
        await new Promise(r => setTimeout(r, 1000));

        console.log("Executing DOM Simplifier inside sandbox...");
        const elements = await tempPage.evaluate(getInteractiveElements);

        console.log(`Extracted ${elements.length} elements. Verifying...`);
        
        // Assertions
        assert.strictEqual(elements.length, 5, "Should extract exactly 5 visible interactive elements.");
        
        // Element 0: Button
        const btn = elements.find(el => el.xpath && el.xpath.includes('btn1'));
        assert.ok(btn, "Should find button tag with btn1 ID.");
        assert.strictEqual(btn.text, "Click Me", "Button label should match 'Click Me'.");

        // Element 1: Input
        const input = elements.find(el => el.xpath && el.xpath.includes('inp1'));
        assert.ok(input, "Should find input tag with inp1 ID.");
        assert.strictEqual(input.text, "Placeholder: Enter name", "Input description should capture placeholder.");

        // Element 2: Link
        const link = elements.find(el => el.xpath && el.xpath.includes('link1'));
        assert.ok(link, "Should find anchor tag with link1 ID.");
        assert.strictEqual(link.text, "Read More", "Link description should match 'Read More'.");

        // Element 3: Image Button
        const imgBtn = elements.find(el => el.xpath && el.xpath.includes('btn-img'));
        assert.ok(imgBtn, "Should find image button.");
        assert.strictEqual(imgBtn.text, "Close Modal", "Image button should inherit inner img alt text.");

        // Element 4: Alt Link
        const altLink = elements.find(el => el.xpath && el.xpath.includes('link-alt'));
        assert.ok(altLink, "Should find link with alt attribute.");
        assert.strictEqual(altLink.text, "Alt: External Link", "Link description should capture alt attribute.");

        console.log("✔ ALL DOM SIMPLIFIER ASSERTIONS PASSED!");

    } catch (e) {
        console.error("❌ TEST FAILED:", e.message);
        process.exit(1);
    } finally {
        if (tempPage) {
            console.log("Closing test tab...");
            await tempPage.close().catch(() => {});
        }
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

runTests();
