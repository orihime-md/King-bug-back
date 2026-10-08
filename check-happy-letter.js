import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const happyPath = path.join(projectDir, 'happy.py');
const serverPath = path.join(projectDir, 'sever.js');

function decodePythonStringEscapes(value = '') {
    return String(value).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[nrtbf\\'"])/g, (match, escape) => {
        if (escape === 'n') return '\n';
        if (escape === 'r') return '\r';
        if (escape === 't') return '\t';
        if (escape === 'b') return '\b';
        if (escape === 'f') return '\f';
        if (escape === '\\' || escape === "'" || escape === '"') return escape;
        const codePoint = Number.parseInt(escape.slice(1), 16);
        if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return match;
        return String.fromCodePoint(codePoint);
    });
}

try {
    const pythonSource = fs.readFileSync(happyPath, 'utf8');
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const literal = pythonSource.match(/^\s*HAPPY_LETTER\s*=\s*("""|''')([\s\S]*?)\1/m);
    const limitMatch = serverSource.match(/\bMAX_HAPPY_LETTER_LENGTH\s*=\s*(\d+)/);

    if (!literal) throw new Error('Could not find HAPPY_LETTER = triple-quoted text in happy.py.');
    if (!limitMatch) throw new Error('Could not find MAX_HAPPY_LETTER_LENGTH in sever.js.');

    const payload = decodePythonStringEscapes(literal[2]);
    const count = Array.from(payload).length;
    const limit = Number(limitMatch[1]);
    if (count === 0) throw new Error('The happy-letter payload is empty.');
    if (count > limit) throw new Error(`Too long: ${count} Unicode code points; configured maximum is ${limit}.`);

    const invisibleCount = Array.from(payload).filter(char => /[\p{Cf}\u200B\u200C\u200D\u2060\uFEFF]/u.test(char)).length;
    console.log(`PASS: happy.py contains ${count}/${limit} Unicode code points.`);
    console.log(`Invisible formatting/zero-width code points detected: ${invisibleCount}.`);
    console.log('This is a local size/content check; WhatsApp delivery still needs a live test after deployment.');
} catch (error) {
    console.error(`FAIL: ${error?.message || error}`);
    process.exitCode = 1;
}
