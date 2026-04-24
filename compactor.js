/**
 * Claw Compactor bridge — calls claw-compactor Python library from Node.
 * Uses the FusionEngine API to compress context before sending to LLM.
 * Falls back to built-in JS compactor when Python package is unavailable.
 */
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const builtin = require('./compactor-builtin')

const COMPACTOR_SCRIPT = path.join(__dirname, 'compactor-bridge.py')

/**
 * Check if claw-compactor is installed
 */
function checkInstalled(pythonPath = 'python3') {
  return new Promise(resolve => {
    execFile(pythonPath, ['-c', 'import scripts.lib.fusion.engine; print("ok")'], { timeout: 5000 }, (err) => {
      if (err) {
        // try pip-installed version
        execFile(pythonPath, ['-c', 'from claw_compactor import FusionEngine; print("ok")'], { timeout: 5000 }, (err2) => {
          resolve(!err2)
        })
      } else {
        resolve(true)
      }
    })
  })
}

/**
 * Compress a list of chat messages using claw-compactor FusionEngine.
 * Falls back to built-in JS compactor if Python bridge fails.
 */
function compressMessages(pythonPath, messages, options = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ messages, options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-messages'], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return resolve(builtin.compressMessages(messages, options))
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) return resolve(result)
        resolve(builtin.compressMessages(messages, options))
      } catch {
        resolve(builtin.compressMessages(messages, options))
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Compress a single text block (e.g. project context).
 * Falls back to built-in JS compactor if Python bridge fails.
 */
function compressText(pythonPath, text, contentType = 'auto', options = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ text, content_type: contentType, ...options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-text'], {
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve(builtin.compressText(text, contentType))
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) return resolve(result)
        resolve(builtin.compressText(text, contentType))
      } catch {
        resolve(builtin.compressText(text, contentType))
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Get compactor status/version info.
 * Always reports installed since built-in fallback is available.
 */
function getStatus(pythonPath) {
  return new Promise(resolve => {
    execFile(pythonPath, [COMPACTOR_SCRIPT, 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ installed: true, version: 'built-in', engine: 'builtin' })
      try {
        const result = JSON.parse(stdout)
        if (result.installed) return resolve({ ...result, engine: 'python' })
        resolve({ installed: true, version: 'built-in', engine: 'builtin' })
      } catch { resolve({ installed: true, version: 'built-in', engine: 'builtin' }) }
    })
  })
}

module.exports = { compressMessages, compressText, getStatus, checkInstalled }
