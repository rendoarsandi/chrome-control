const { connectTab } = require('./src/cdp');
const https = require('https');
const fs = require('fs');

async function fetchTask() {
    const { session } = await connectTab('azurewebsites');
    
    // Extract prompt and image URLs
    const res = await session.send('Runtime.evaluate', {
        expression: `(() => {
            const body = document.body ? document.body.innerText : '';
            const imgs = Array.from(document.images).filter(i => (i.naturalWidth >= 500 || i.width >= 500) && !i.src.includes('data:image'));
            return JSON.stringify({
                bodySnippet: body.substring(0, 800),
                images: imgs.map(i => i.src)
            });
        })()`,
        returnByValue: true
    });
    
    const data = JSON.parse(res.result.value);
    session.close();

    const imgUrls = data.images.slice(-2);
    if (imgUrls.length < 2) {
        throw new Error('Could not locate the 2 task images.');
    }

    // Download in parallel
    const download = (url, path) => new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const file = fs.createWriteStream(path);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
    });

    await Promise.all([
        download(imgUrls[0], 'task_img1.jpg'),
        download(imgUrls[1], 'task_img2.jpg')
    ]);

    console.log("=== PROMPT & CONTEXT ===");
    console.log(data.bodySnippet);
    console.log("\n=== IMAGES READY ===");
    console.log("Image 1 saved to: task_img1.jpg");
    console.log("Image 2 saved to: task_img2.jpg");
}

fetchTask().catch(err => {
    console.error("Fetch Error:", err.message);
    process.exit(1);
});
