'use strict';

const { parentPort, workerData } = require('node:worker_threads');

/**
 * Worker thread for regex matching against file contents.
 * Receives: { files: [{ filePath, content, relativePath }], pattern, flags }
 * Returns:  { results: [{ file, startLine, endLine, snippet, matchedPattern }] }
 */

const { files, pattern, flags } = workerData;

const results = [];
let regex;
try {
  regex = new RegExp(pattern, flags);
} catch (_) {
  regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

for (const { content, relativePath } of files) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    const match = regex.exec(lines[i]);
    if (match) {
      results.push({
        file: relativePath,
        startLine: i + 1,
        endLine: i + 1,
        snippet: lines[i].trimEnd(),
        matchedPattern: match[0],
      });
    }
  }
}

parentPort.postMessage({ results });
