const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3001;

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.me5': 'application/octet-stream',
    '.ME5': 'application/octet-stream',
    '.xml': 'application/xml'
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    
    let url = req.url;
    if (url === '/') url = '/IR-Command-Import-Tool.html';
    
    if (url === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', me5Creation: true }));
        return;
    }
    
    if (url === '/api/create-me5' && req.method === 'POST') {
        handleCreateME5(req, res);
        return;
    }
    
    const filePath = path.join(__dirname, decodeURIComponent(url));
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end(content);
        }
    });
});

function parseMultipart(req, callback) {
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.match(/boundary=([^;]+)/)?.[1]?.trim();
    if (!boundary) return callback(new Error('No boundary found'));

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from('--' + boundary);
        const endBoundaryBuf = Buffer.from('--' + boundary + '--');
        const parts = {};
        let start = 0;

        while (true) {
            const bIdx = buffer.indexOf(boundaryBuf, start);
            if (bIdx === -1) break;
            const nextB = buffer.indexOf(boundaryBuf, bIdx + boundaryBuf.length);
            const endIdx = nextB !== -1 ? nextB : buffer.indexOf(endBoundaryBuf, bIdx);
            if (endIdx === -1) break;

            const part = buffer.slice(bIdx + boundaryBuf.length + 2, endIdx - 2);
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
                const headers = part.slice(0, headerEnd).toString();
                const data = part.slice(headerEnd + 4);
                const nameMatch = headers.match(/name="([^"]+)"/);
                if (nameMatch) parts[nameMatch[1]] = data;
            }
            start = endIdx;
        }
        callback(null, parts);
    });
    req.on('error', callback);
}

function handleCreateME5(req, res) {
    parseMultipart(req, (err, parts) => {
        if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
        }
        try {
            let me5Buffer = parts['originalMe5'];
            const modifiedXml = parts['modifiedXml'].toString('utf8');
            const originalMe5Name = (parts['originalMe5Name'] || Buffer.from('modified.ME5')).toString('utf8');
            const isCompressed = parts['compressed'] && parts['compressed'].toString() === 'true';

            if (!me5Buffer || !modifiedXml) throw new Error('Missing required fields');

            if (isCompressed) {
                console.log('[CreateME5] Decompressing gzip data...');
                const before = me5Buffer.length;
                me5Buffer = zlib.gunzipSync(me5Buffer);
                console.log(`[CreateME5] Decompressed: ${before} -> ${me5Buffer.length} bytes`);
            }

            console.log('[CreateME5] Original size:', me5Buffer.length);

            const zip = new AdmZip(me5Buffer);
            const entries = zip.getEntries();
            console.log('[CreateME5] Files in original:', entries.length);

            const xmlEntry = entries.find(e =>
                e.entryName.toLowerCase().endsWith('.xml') &&
                e.entryName.includes('Documents')
            );
            if (!xmlEntry) throw new Error('Could not find XML file in ME5');

            const xmlPath = xmlEntry.entryName;
            console.log('[CreateME5] Replacing XML:', xmlPath);

            zip.deleteFile(xmlPath);
            zip.addFile(xmlPath, Buffer.from(modifiedXml, 'utf8'), '', 0);

            const outputBuffer = zip.toBuffer();
            console.log('[CreateME5] Output size:', outputBuffer.length);

            const outputFilename = originalMe5Name.replace(/[^a-zA-Z0-9._\- ]/g, '_');

            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${outputFilename}"`,
                'Content-Length': outputBuffer.length,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(outputBuffer);

        } catch (e) {
            console.error('[CreateME5] Error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
    });
}

server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('IR Command Import Tool Server (AdmZip Version)');
    console.log('='.repeat(60));
    console.log(`\nServer running at: http://localhost:${PORT}`);
    console.log('\nPress Ctrl+C to stop the server');
    console.log('='.repeat(60));
});
