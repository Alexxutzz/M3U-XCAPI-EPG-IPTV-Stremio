const createAddon = require("./addon");
const { getRouter } = require("stremio-addon-sdk");
const path = require("path");
const fs = require("fs");

let cachedInterface = null;

module.exports = async function (req, res) {
    try {
        // 1. Servire Pagina Configurare
        if (req.url === '/' || req.url === '/configure') {
            const configPath = path.join(__dirname, 'configure.html');
            if (fs.existsSync(configPath)) {
                res.setHeader('Content-Type', 'text/html');
                return res.end(fs.readFileSync(configPath));
            }
        }

        // 2. Mapare Variabile Vercel -> Addon Config
        // Am mapat numele tale din .env/Vercel pe cheile din addon.js
        const vConfig = {
            provider: process.env.DATA_PROVIDER || 'xtream',
            // Xtream specific
            xtreamUrl: process.env.XTREAM_HOST || process.env.XTREAM_URL,
            xtreamUsername: process.env.XTREAM_USER || process.env.XTREAM_USERNAME,
            xtreamPassword: process.env.XTREAM_PASSWORD,
            // Direct specific (dacă e cazul)
            m3uUrl: process.env.M3U_URL,
            epgUrl: process.env.EPG_URL,
            // General
            debug: process.env.DEBUG_MODE === 'true',
            includeSeries: process.env.INCLUDE_SERIES !== 'false'
        };

        // 3. Singleton pentru performanță
        if (!cachedInterface) {
            console.log("[SERVERLESS] Initializing addon with provider:", vConfig.provider);
            cachedInterface = await createAddon(vConfig);
        }

        const router = getRouter(cachedInterface);
        router(req, res, function () {
            res.statusCode = 404;
            res.end();
        });

    } catch (e) {
        console.error('[SERVERLESS] Critical Error:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Check Vercel Logs', message: e.message }));
    }
};
