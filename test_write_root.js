const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'data/scraper');
const file = path.join(dir, 'test_write.json');
try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ test: true }), 'utf8');
    console.log("Success writing to " + file);
} catch (e) {
    console.log("Error: " + e.message);
}
