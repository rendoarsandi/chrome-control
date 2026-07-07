const https = require('https');

const key = process.env.GEMINI_API_KEY;
const project = process.env.VERTEX_PROJECT_ID || "gen-lang-client-0471281580";

async function testRequest(domain, location, model) {
    return new Promise((resolve) => {
        const url = `https://${domain}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent?key=${key}`;
        console.log(`Testing URL: ${url}`);
        
        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [{ text: "Hi, reply with 'Hello' if you read this." }]
                }
            ]
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
                console.log(`Status: ${res.statusCode}`);
                console.log(`Response: ${body.substring(0, 300)}`);
                resolve(res.statusCode === 200);
            });
        });
        
        req.on('error', (err) => {
            console.log(`Error: ${err.message}`);
            resolve(false);
        });
        
        req.write(data);
        req.end();
    });
}

async function run() {
    const tests = [
        { domain: "aiplatform.googleapis.com", location: "global", model: "gemini-2.5-flash" },
        { domain: "aiplatform.googleapis.com", location: "global", model: "gemini-3.5-flash" }
    ];
    
    for (const test of tests) {
        console.log(`\n=== Testing ${test.location} / ${test.model} ===`);
        await testRequest(test.domain, test.location, test.model);
    }
}

run();
