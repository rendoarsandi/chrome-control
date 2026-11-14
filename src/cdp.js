/**
 * CDP (Chrome DevTools Protocol) Client for Termux & Android Chrome
 * Lightweight, robust, zero-dependency, native WebSocket implementation.
 * Provides full agentic capabilities: See, Click, Input, Scroll, KeyPress, Screenshot, Tab Management.
 */

Object.defineProperty(process, 'platform', { value: 'linux' });

const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

function execSafe(cmd) {
    try {
        return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    } catch (e) {
        return (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    }
}

/**
 * Automatically discovers Google Chrome's devtools socket on Android via ADB and forwards it to tcp:port.
 */
async function autoForwardChrome(port = 9222) {
    try {
        const adbOut = execSafe('adb devices');
        const lines = adbOut.split('\n').filter(l => l.trim().length > 0);
        const devices = lines.slice(1).map(l => l.split('\t')[0].trim()).filter(s => s && !s.includes('offline'));
        
        if (devices.length === 0) {
            return { ok: false, error: 'No active ADB devices connected.' };
        }

        const serial = devices[0];

        // Find devtools sockets
        const unixSockets = execSafe(`adb -s ${serial} shell "cat /proc/net/unix | grep devtools"`);
        const socketMatches = unixSockets.match(/@chrome_devtools_remote(_\d+)?/g) || [];
        
        // Find PID of com.android.chrome specifically
        const psOut = execSafe(`adb -s ${serial} shell "ps -A | grep -E 'com.android.chrome$'"`).trim();
        let targetSocket = 'chrome_devtools_remote';

        if (psOut) {
            const parts = psOut.split(/\s+/);
            const pid = parts[1];
            if (pid && socketMatches.includes(`@chrome_devtools_remote_${pid}`)) {
                targetSocket = `chrome_devtools_remote_${pid}`;
            }
        } else if (socketMatches.length > 0) {
            const specific = socketMatches.find(s => s.startsWith('@chrome_devtools_remote_'));
            if (specific) {
                targetSocket = specific.replace('@', '');
            } else {
                targetSocket = socketMatches[0].replace('@', '');
            }
        }

        execSafe(`adb -s ${serial} forward tcp:${port} localabstract:${targetSocket}`);
        return { ok: true, socket: targetSocket, device: serial };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Query active targets/tabs via HTTP /json/list
 */
function listTabs(host = '127.0.0.1', port = 9222) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}/json/list`, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const tabs = JSON.parse(data);
                    resolve(tabs);
                } catch (e) {
                    reject(new Error(`Failed to parse tabs JSON: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Connection to CDP HTTP endpoint timed out.'));
        });
    });
}

/**
 * Open a new tab
 */
function newTab(url = 'https://google.com', host = '127.0.0.1', port = 9222) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}/json/new?${encodeURIComponent(url)}`, { timeout: 4000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ url, raw: data });
                }
            });
        });
        req.on('error', reject);
    });
}

/**
 * Close a tab by ID
 */
function closeTab(tabId, host = '127.0.0.1', port = 9222) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}/json/close/${tabId}`, { timeout: 3000 }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve({ ok: true }));
        });
        req.on('error', reject);
    });
}

/**
 * Check CDP version info
 */
function getVersion(host = '127.0.0.1', port = 9222) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}/json/version`, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('CDP version check timed out.'));
        });
    });
}

/**
 * Direct CDP Session connected to a specific Tab WebSocket
 */
class CDPSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 1;
        this.pendingRequests = new Map();
        this.isOpen = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.wsUrl);
                
                this.ws.onopen = async () => {
                    this.isOpen = true;
                    // Enable standard CDP domains
                    await this.send('Runtime.enable').catch(() => {});
                    await this.send('Page.enable').catch(() => {});
                    await this.send('DOM.enable').catch(() => {});
                    resolve(this);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.id && this.pendingRequests.has(msg.id)) {
                            const { resolve: reqResolve, reject: reqReject } = this.pendingRequests.get(msg.id);
                            this.pendingRequests.delete(msg.id);
                            if (msg.error) {
                                reqReject(new Error(msg.error.message || JSON.stringify(msg.error)));
                            } else {
                                reqResolve(msg.result);
                            }
                        }
                    } catch (e) {
                        console.error('Error handling WebSocket message:', e);
                    }
                };

                this.ws.onerror = (err) => {
                    reject(err);
                };

                this.ws.onclose = () => {
                    this.isOpen = false;
                };
            } catch (err) {
                reject(err);
            }
        });
    }

    send(method, params = {}) {
        if (!this.isOpen) {
            return Promise.reject(new Error('CDPSession WebSocket is not open.'));
        }
        const id = this.msgId++;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expression, awaitPromise = true) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise
        });
        if (result && result.result) {
            if (result.result.type === 'undefined') return undefined;
            return result.result.value;
        }
        return result;
    }

    async getTitle() {
        return await this.eval('document.title');
    }

    async getUrl() {
        return await this.eval('window.location.href');
    }

    async getBodyText() {
        return await this.eval('document.body ? document.body.innerText : ""');
    }

    /**
     * "See" the page: returns structured snapshot of all interactive elements with IDs
     */
    async getInteractiveElements() {
        const script = `(() => {
            const tags = ['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[role="radio"]', '[role="checkbox"]', '[role="tab"]', '[role="link"]', '[tabindex]:not([tabindex="-1"])'];
            const allElements = Array.from(document.querySelectorAll(tags.join(',')));
            
            let idCounter = 1;
            const seen = [];

            for (const el of allElements) {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                
                // Visible check
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || el.alt || '').trim();
                    const tag = el.tagName.toLowerCase();
                    const type = el.type || el.getAttribute('role') || '';
                    const isChecked = el.checked || el.getAttribute('aria-checked') === 'true';
                    const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';

                    // Tag element with temporary index for quick lookup
                    el.dataset.agentIndex = idCounter;

                    seen.push({
                        index: idCounter,
                        tag,
                        type,
                        text: text.substring(0, 100).replace(/\\n/g, ' '),
                        checked: isChecked,
                        disabled: isDisabled,
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    });
                    idCounter++;
                }
            }
            return seen;
        })()`;
        return await this.eval(script);
    }

    /**
     * Human-readable formatted page overview
     */
    async see() {
        const title = await this.getTitle();
        const url = await this.getUrl();
        const elements = await this.getInteractiveElements();

        let output = `\n=======================================================\n`;
        output += `🌐 Page: "${title}"\n`;
        output += `🔗 URL:  ${url}\n`;
        output += `=======================================================\n`;
        output += `Interactive Elements (${elements.length}):\n`;

        elements.forEach(el => {
            let status = '';
            if (el.checked) status += ' [CHECKED]';
            if (el.disabled) status += ' [DISABLED]';
            output += `  [#${el.index}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> "${el.text}" (at x:${el.x}, y:${el.y})${status}\n`;
        });

        output += `=======================================================\n`;
        return output;
    }

    /**
     * Click element by index, text, CSS selector, or { x, y } coordinates
     */
    async click(target) {
        // If target is coordinate object or string like "350,500"
        if (typeof target === 'object' && target.x !== undefined && target.y !== undefined) {
            return await this.clickAt(target.x, target.y);
        }
        if (typeof target === 'string' && /^\d+\s*,\s*\d+$/.test(target.trim())) {
            const [x, y] = target.trim().split(',').map(n => parseInt(n.trim(), 10));
            return await this.clickAt(x, y);
        }

        const script = `(() => {
            const rawTarget = ${JSON.stringify(target)}.trim();
            let el = null;

            // 1. Check if index e.g. "1" or "#1" or "[#1]"
            const indexMatch = rawTarget.match(/^(\\[?#?)(\\d+)\\]?$/);
            if (indexMatch) {
                const targetIdx = indexMatch[2];
                el = document.querySelector(\`[data-agent-index="\${targetIdx}"]\`);
                if (!el) {
                    // Re-index and find
                    const tags = ['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[role="radio"]', '[role="checkbox"]', '[role="tab"]', '[role="link"]', '[tabindex]:not([tabindex="-1"])'];
                    const visible = Array.from(document.querySelectorAll(tags.join(','))).filter(e => {
                        const r = e.getBoundingClientRect();
                        const s = window.getComputedStyle(e);
                        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                    });
                    el = visible[parseInt(targetIdx, 10) - 1];
                }
            }

            // 2. Check if CSS selector
            if (!el && (rawTarget.startsWith('.') || rawTarget.startsWith('#') || rawTarget.startsWith('[') || rawTarget.includes(':') || rawTarget.includes(' '))) {
                try {
                    el = document.querySelector(rawTarget);
                } catch (e) {}
            }

            // 3. Match by text
            if (!el) {
                const lower = rawTarget.toLowerCase();
                const candidates = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button], [role=radio], [role=checkbox], span, div, label, p, h1, h2, h3'));
                el = candidates.find(c => (c.innerText || c.value || '').trim().toLowerCase() === lower)
                  || candidates.find(c => (c.innerText || c.value || '').trim().toLowerCase().includes(lower));
            }

            if (el) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                el.focus();
                el.click();
                if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
                    el.checked = true;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const rect = el.getBoundingClientRect();
                return {
                    success: true,
                    tag: el.tagName,
                    text: (el.innerText || el.value || '').trim(),
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                };
            }

            return { success: false, error: 'Element not found: ' + rawTarget };
        })()`;

        const res = await this.eval(script);
        if (res && res.success && res.x && res.y) {
            // Also dispatch low-level CDP touch/mouse for framework compatibility
            await this.clickAt(res.x, res.y).catch(() => {});
        }
        return res;
    }

    /**
     * Dispatch native CDP mouse click at (x, y) coordinates
     */
    async clickAt(x, y) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50));
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return { success: true, x, y };
    }

    /**
     * Type text into an element or the currently focused element
     */
    async type(target, text) {
        if (text === undefined) {
            // If only one arg, type into focused element
            text = target;
            target = null;
        }

        if (target) {
            const script = `(() => {
                const rawTarget = ${JSON.stringify(target)}.trim();
                let el = null;

                const indexMatch = rawTarget.match(/^(\\[?#?)(\\d+)\\]?$/);
                if (indexMatch) {
                    const targetIdx = indexMatch[2];
                    el = document.querySelector(\`[data-agent-index="\${targetIdx}"]\`);
                }

                if (!el) {
                    try { el = document.querySelector(rawTarget); } catch (e) {}
                }

                if (!el) {
                    const lower = rawTarget.toLowerCase();
                    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
                    el = inputs.find(i => (i.placeholder || i.name || i.id || '').toLowerCase().includes(lower));
                }

                if (el) {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    el.focus();
                    el.value = ${JSON.stringify(text)};
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true };
                }
                return { success: false, error: 'Target input not found: ' + rawTarget };
            })()`;
            return await this.eval(script);
        } else {
            // Send character-by-character key events
            for (const char of text) {
                await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
                await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
            }
            return { success: true, text };
        }
    }

    /**
     * Send specific key press (e.g. Enter, Tab, Escape, Backspace, ArrowDown)
     */
    async pressKey(key) {
        const keyMap = {
            'enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
            'tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
            'escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
            'backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
            'space': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
            'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
            'arrowup': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
            'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
            'arrowright': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
        };

        const keyDef = keyMap[key.toLowerCase()] || { key, code: key };
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyDef });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyDef });
        return { success: true, key };
    }

    /**
     * Scroll the page (up, down, top, bottom, or delta pixels)
     */
    async scroll(direction = 'down', amount = 400) {
        let script = '';
        if (direction === 'down') {
            script = `window.scrollBy({ top: ${amount}, behavior: 'smooth' });`;
        } else if (direction === 'up') {
            script = `window.scrollBy({ top: -${amount}, behavior: 'smooth' });`;
        } else if (direction === 'top') {
            script = `window.scrollTo({ top: 0, behavior: 'smooth' });`;
        } else if (direction === 'bottom') {
            script = `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });`;
        }
        await this.eval(script);
        await new Promise(r => setTimeout(r, 400));
        return { success: true, direction, amount };
    }

    /**
     * Navigate page to URL
     */
    async navigate(url) {
        await this.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 2000));
        return await this.getUrl();
    }

    /**
     * Capture page screenshot
     */
    async screenshot(filePath = 'screenshot.png') {
        const result = await this.send('Page.captureScreenshot', { format: 'png' });
        if (result && result.data) {
            const buffer = Buffer.from(result.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { success: true, path: filePath, size: buffer.length };
        }
        throw new Error('Failed to capture screenshot data.');
    }

    close() {
        if (this.ws && this.isOpen) {
            this.ws.close();
        }
    }
}

/**
 * High level helper to connect to a target tab by keyword (or first active page)
 */
async function connectTab(keyword = '', host = '127.0.0.1', port = 9222) {
    let tabs;
    try {
        tabs = await listTabs(host, port);
    } catch (e) {
        await autoForwardChrome(port);
        await new Promise(r => setTimeout(r, 1000));
        tabs = await listTabs(host, port);
    }

    if (!Array.isArray(tabs) || tabs.length === 0) {
        throw new Error('No active browser tabs found.');
    }

    const pageTabs = tabs.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pageTabs.length === 0) {
        throw new Error('No open page targets with WebSocket debugging enabled found.');
    }

    let targetTab = pageTabs[0];
    if (keyword) {
        const lower = keyword.toLowerCase();
        const matched = pageTabs.find(t => 
            (t.title && t.title.toLowerCase().includes(lower)) || 
            (t.url && t.url.toLowerCase().includes(lower))
        );
        if (matched) targetTab = matched;
    }

    const session = new CDPSession(targetTab.webSocketDebuggerUrl);
    await session.connect();
    return { session, tab: targetTab };
}

module.exports = {
    autoForwardChrome,
    listTabs,
    newTab,
    closeTab,
    getVersion,
    CDPSession,
    connectTab
};
