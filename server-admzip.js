const express = require('express');
const multer = require('multer');
const path = require('path');
const AdmZip = require('adm-zip');
const ZipCrypto = require('adm-zip/methods/zipcrypto');
const zlib = require('zlib');
const utils = require('adm-zip/util/utils');

const PORT = process.env.PORT || 3001;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 } });

// ME5 encryption password
const ME5_PASSWORD = 'The sound was as soft as the first drop of rain on a century of dust.';

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Serve static HTML
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'IR-Command-Import-Tool.html')));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', me5Creation: true }));

// ME5 creation endpoint - multer handles binary multipart upload
app.post('/api/create-me5', upload.single('originalMe5'), (req, res) => {
    try {
        if (!req.file) throw new Error('No ME5 file received');
        const modifiedXml = req.body.modifiedXml;
        const originalMe5Name = req.body.originalMe5Name || 'modified.ME5';
        if (!modifiedXml) throw new Error('No XML received');

        console.log(`[CreateME5] ME5: ${req.file.size} bytes, XML: ${modifiedXml.length} chars`);

        const zip = new AdmZip(req.file.buffer, ME5_PASSWORD);
        const entries = zip.getEntries();
        console.log(`[CreateME5] Files in ME5: ${entries.length}`);

        // Read meta.json to find the startDocument (the main pageset XML)
        const metaEntry = entries.find(e => e.entryName.endsWith('meta.json'));
        let targetXmlName = null;
        if (metaEntry) {
            try {
                const meta = JSON.parse(metaEntry.getData().toString('utf8'));
                targetXmlName = meta.startDocument;
                console.log(`[CreateME5] meta.json startDocument: ${targetXmlName}`);
            } catch (e) {
                console.log('[CreateME5] Could not parse meta.json, falling back');
            }
        }

        // Also check if client sent the XML filename (now sends full path inside zip)
        const clientXmlName = req.body.xmlFilename;
        if (clientXmlName) {
            console.log(`[CreateME5] Client sent xmlFilename: ${clientXmlName}`);
            // Use client path as highest priority since it's the actual zip entry path
            targetXmlName = clientXmlName;
        }

        // Find the XML entry matching the target path
        let xmlEntry;
        if (targetXmlName) {
            // Try exact match first
            xmlEntry = entries.find(e => e.entryName === targetXmlName);
            // Try endsWith match (in case of path differences)
            if (!xmlEntry) {
                xmlEntry = entries.find(e =>
                    e.entryName.toLowerCase().endsWith('.xml') &&
                    e.entryName.toLowerCase().endsWith(targetXmlName.toLowerCase())
                );
            }
        }
        if (!xmlEntry) {
            // Fallback: find first XML in Documents/ folder
            xmlEntry = entries.find(e =>
                e.entryName.toLowerCase().endsWith('.xml') &&
                e.entryName.includes('Documents')
            );
        }
        if (!xmlEntry) throw new Error('Could not find XML file in ME5');

        const xmlPath = xmlEntry.entryName;
        console.log(`[CreateME5] Replacing: ${xmlPath}`);

        // Update the entry in-place using setData (preserves header including encryption flag)
        const wasEncrypted = xmlEntry.header.encrypted;
        const origMethod = xmlEntry.header.method;
        console.log(`[CreateME5] Original: encrypted=${wasEncrypted}, method=${origMethod}`);

        const xmlBuffer = Buffer.from(modifiedXml, 'utf8');

        if (!wasEncrypted) {
            // Entry wasn't encrypted, just update normally
            xmlEntry.setData(xmlBuffer);
            const outputBuffer = zip.toBuffer();
            console.log(`[CreateME5] Output (unencrypted): ${outputBuffer.length} bytes`);
            const outputFilename = originalMe5Name.replace(/[^a-zA-Z0-9._\- ]/g, '_');
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
            res.setHeader('Content-Length', outputBuffer.length);
            res.send(outputBuffer);
            return;
        }

        // For encrypted entries: manually compress + encrypt, then override getCompressedData
        // adm-zip compresses but does NOT encrypt on write, so we do it ourselves
        const compressedData = zlib.deflateRawSync(xmlBuffer);
        const crc = utils.crc32(xmlBuffer);

        // Update header with correct values
        xmlEntry.header.crc = crc;
        xmlEntry.header.size = xmlBuffer.length;
        xmlEntry.header.encrypted = true;
        xmlEntry.header.flags |= 0x1;

        // Encrypt the compressed data (adds 12-byte salt header)
        const encryptedData = ZipCrypto.encrypt(compressedData, xmlEntry.header, ME5_PASSWORD);
        xmlEntry.header.compressedSize = encryptedData.length;

        console.log(`[CreateME5] Compressed: ${compressedData.length}, Encrypted: ${encryptedData.length}`);

        // Override getCompressedData so toBuffer() uses our pre-encrypted data
        xmlEntry.getCompressedData = function() { return encryptedData; };

        const outputBuffer = zip.toBuffer();
        console.log(`[CreateME5] Output: ${outputBuffer.length} bytes`);

        const outputFilename = originalMe5Name.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
        res.setHeader('Content-Length', outputBuffer.length);
        res.send(outputBuffer);

    } catch (e) {
        console.error('[CreateME5] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('IR Command Import Tool Server (Express + Multer)');
    console.log('='.repeat(60));
    console.log(`\nServer running at: http://localhost:${PORT}`);
    console.log('='.repeat(60));
});
