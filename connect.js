#!/data/data/com.termux/files/usr/bin/env node
Object.defineProperty(process, 'platform', { value: 'linux' });

const { autoForwardChrome, listTabs, getVersion } = require('./src/cdp');

async function main() {
    console.log("==================================================");
    console.log("       Chrome Control - Connection Diagnostic     ");
    console.log("==================================================\n");

    console.log("🔍 Checking ADB & DevTools sockets...");
    const fwd = await autoForwardChrome(9222);
    if (fwd.ok) {
        console.log(`📱 ADB Device: ${fwd.device}`);
        console.log(`🔌 Forwarded socket: @${fwd.socket} -> tcp:9222\n`);
    } else {
        console.log(`⚠️  ADB Auto-forward note: ${fwd.error}`);
    }

    try {
        const ver = await getVersion('127.0.0.1', 9222);
        console.log(`✅ Chrome is CONNECTED!`);
        console.log(`   Browser: ${ver.Browser || 'Chrome'}`);
        console.log(`   Package: ${ver['Android-Package'] || 'Android'}`);
        
        const tabs = await listTabs('127.0.0.1', 9222);
        console.log(`\n📑 Open Tabs (${tabs.length}):`);
        tabs.forEach((t, i) => {
            console.log(`   [${i + 1}] (${t.type}) ${t.title || 'Untitled'}`);
            if (t.url) console.log(`       URL: ${t.url}`);
        });

        console.log("\n🚀 You can run commands now:");
        console.log("   ./chrome-control-cli --get-title");
        console.log("   ./chrome-control-cli --solve-annotation");
        console.log("   ./chrome-control-cli -i");
    } catch (err) {
        console.error("\n❌ Could not connect to Chrome DevTools endpoint on port 9222.");
        console.error("Reason:", err.message);
        console.log("\nQuick Troubleshooting:");
        console.log("1. Make sure Chrome is running with at least one webpage open.");
        console.log("2. If ADB disconnected, reconnect with: adb connect <IP>:<PORT>");
    }
}

main();
