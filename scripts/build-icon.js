const fs = require("fs");
const path = require("path");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function loadSharp() {
    try {
        return require("sharp");
    } catch {
        console.warn("sharp not installed — using square icon. Run: npm install sharp --save-dev");
        return null;
    }
}

async function makeRoundedSquarePng(sharp, inputPath, size) {
    const radius = Math.round(size * 0.24);
    const padding = Math.max(1, Math.round(size * 0.05));
    const inner = size - padding * 2;

    const resized = await sharp(inputPath)
        .resize(inner, inner, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();

    const canvas = await sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
    })
        .composite([{ input: resized, left: padding, top: padding }])
        .png()
        .toBuffer();

    const mask = Buffer.from(
        `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
    );

    return sharp(canvas)
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer();
}

async function main() {
    const root = path.join(__dirname, "..");
    const buildDir = path.join(root, "build");
    const untitled = path.join(root, "Untitled design.png");
    const rawPng = path.join(buildDir, "icon-source.png");
    const ico = path.join(buildDir, "icon.ico");
    const outPng = path.join(buildDir, "icon.png");
    const sizesDir = path.join(buildDir, "icon-sizes");

    if (!fs.existsSync(untitled) && !fs.existsSync(rawPng)) {
        console.error("Missing Untitled design.png — add logo to project root");
        process.exit(1);
    }

    if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
    if (!fs.existsSync(sizesDir)) fs.mkdirSync(sizesDir, { recursive: true });

    if (fs.existsSync(untitled)) {
        fs.copyFileSync(untitled, rawPng);
        console.log("Source:", untitled);
    }
    const source = rawPng;

    const sharp = await loadSharp();
    const pngToIco = (await import("png-to-ico")).default;

    if (sharp) {
        const sizePaths = [];
        for (const size of ICO_SIZES) {
            const buf = await makeRoundedSquarePng(sharp, source, size);
            const p = path.join(sizesDir, `icon-${size}.png`);
            fs.writeFileSync(p, buf);
            sizePaths.push(p);
        }
        const master = await makeRoundedSquarePng(sharp, source, 512);
        fs.writeFileSync(outPng, master);
        console.log("Created rounded-square", outPng, "+", sizePaths.length, "sizes");

        fs.writeFileSync(ico, await pngToIco(sizePaths));
    } else {
        if (path.resolve(source) !== path.resolve(outPng)) fs.copyFileSync(source, outPng);
        fs.writeFileSync(ico, await pngToIco(outPng));
    }

    console.log("Created", ico);
    fs.copyFileSync(ico, path.join(root, "app_icon.ico"));
}

main().catch((e) => { console.error(e); process.exit(1); });
