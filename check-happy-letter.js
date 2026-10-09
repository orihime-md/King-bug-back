import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
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
        if (!Number.isFinite(codePoint) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
        return String.fromCodePoint(codePoint);
    });
}

function parseHappyLetter(source = '') {
    const triple = source.match(/HAPPY_LETTER\s*=\s*("""|''')([\s\S]*?)\1/);
    if (triple) return decodePythonStringEscapes(triple[2]);

    const single = source.match(/HAPPY_LETTER\s*=\s*(['"])([\s\S]*?)(?<!\\)\1/);
    if (single) return decodePythonStringEscapes(single[2]);

    let fallback = source.replace(/^\uFEFF/, '');
    fallback = fallback.replace(/^\s*HAPPY_LETTER\s*=\s*/, '');
    const wrapped = fallback.match(/^("""|'''|["'])([\s\S]*)\1\s*$/);
    if (wrapped) fallback = wrapped[2];
    return decodePythonStringEscapes(fallback);
}

try {
    const source = fs.readFileSync(happyPath, 'utf8');
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const payload = parseHappyLetter(source);
    const visibleLimitMatch = serverSource.match(/\bMAX_HAPPY_LETTER_LENGTH\s*=\s*(\d+)/);
    const invisibleLimitMatch = serverSource.match(/MAX_HAPPY_LETTER_INVISIBLE_CHARS\s*=\s*Math\.min\(\s*Number\(process\.env\.HAPPY_LETTER_INVISIBLE_LIMIT\s*\|\|\s*(\d+)\)\s*,\s*HAPPY_LETTER_HARD_CHAR_CEILING\s*\)/);
    const hardLimitMatch = serverSource.match(/HAPPY_LETTER_HARD_CHAR_CEILING\s*=\s*(\d+)/);
    const batchSizeMatch = serverSource.match(/HAPPY_LETTER_BATCH_SIZE\s*=\s*(\d+)/);
    const batchesLimitMatch = serverSource.match(/MAX_HAPPY_LETTER_BATCHES\s*=\s*(\d+)/);
    const delayMatch = serverSource.match(/HAPPY_LETTER_BATCH_DELAY_MS\s*=\s*(\d+)/);

    if (!payload.length) throw new Error('The happy-letter payload is empty.');
    if (!visibleLimitMatch || !invisibleLimitMatch || !hardLimitMatch || !batchSizeMatch || !batchesLimitMatch || !delayMatch) {
        throw new Error('Could not read the visible, invisible, or batch limits from sever.js.');
    }

    const visibleLimit = Number(visibleLimitMatch[1]);
    const invisibleLimit = Math.min(
        Number(process.env.HAPPY_LETTER_INVISIBLE_LIMIT || invisibleLimitMatch[1]),
        Number(hardLimitMatch[1])
    );
    const batchSize = Number(batchSizeMatch[1]);
    const maxBatches = Number(batchesLimitMatch[1]);
    const delayMs = Number(delayMatch[1]);
    const invisibleChar = /[\p{Cf}\u200B\u200C\u200D\u2060\uFEFF]/u;
    let totalCodePoints = 0;
    let visibleCount = 0;
    let invisibleCount = 0;
    for (const character of payload) {
        totalCodePoints++;
        if (invisibleChar.test(character)) invisibleCount++;
        else visibleCount++;
    }

    if (visibleCount > visibleLimit) {
        throw new Error(`Too much visible text: ${visibleCount} Unicode code points; configured maximum is ${visibleLimit}.`);
    }

    const totalBatchCapacity = batchSize * maxBatches;
    const sentCodePoints = Math.min(totalCodePoints, totalBatchCapacity);
    const remainingCodePoints = totalCodePoints - sentCodePoints;
    const batchCount = Math.min(maxBatches, Math.ceil(totalCodePoints / batchSize));
    const legacyInvisibleKept = Math.min(invisibleCount, invisibleLimit);

    console.log(`PASS: visible text ${visibleCount}/${visibleLimit} code points; payload has ${totalCodePoints.toLocaleString()} total code points.`);
    console.log(`.sus-gc: keeps up to ${legacyInvisibleKept.toLocaleString()}/${invisibleLimit.toLocaleString()} invisible characters in one message.`);
    console.log(`.2: sends at most ${batchCount} batch(es) × ${batchSize.toLocaleString()} characters (${sentCodePoints.toLocaleString()} maximum), with ${delayMs} ms between batches.`);
    if (remainingCodePoints) console.log(`.2: ${remainingCodePoints.toLocaleString()} code points remain unsent after the ${maxBatches}-batch limit.`);
    console.log('This is a local payload/limit check; actual WhatsApp delivery still needs a live test.');
} catch (error) {
    console.error(`FAIL: ${error?.message || error}`);
    process.exitCode = 1;
}
