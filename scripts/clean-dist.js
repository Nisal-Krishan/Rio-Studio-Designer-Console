const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");
if (fs.existsSync(dist)) {
    fs.rmSync(dist, { recursive: true, force: true });
    console.log("Cleaned dist/");
}
