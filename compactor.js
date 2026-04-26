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
 * Forwards per-message contentType hints and dedup option to the Python bridge.
 * Falls back to built-in JS compactor if Python bridge fails.
 */
function compressMessages(pythonPath, messages, options = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ messages, options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-messages'], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        return resolve(fallback)
      }
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) {
          result.stats.engine = 'python'
          return resolve(result)
        }
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      } catch {
        const fallback = builtin.compressMessages(messages, options)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Compress a single text block (e.g. project context).
 * Returns rewind_key from the Python bridge response when present.
 * Falls back to built-in JS compactor if Python bridge fails.
 */
function compressText(pythonPath, text, contentType = 'auto', options = {}) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ text, content_type: contentType, ...options })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'compress-text'], {
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        const fallback = builtin.compressText(text, contentType)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        return resolve(fallback)
      }
      try {
        const result = JSON.parse(stdout)
        if (result.stats?.compressed) {
          result.stats.engine = 'python'
          return resolve(result)
        }
        const fallback = builtin.compressText(text, contentType)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      } catch {
        const fallback = builtin.compressText(text, contentType)
        fallback.stats = { ...fallback.stats, engine: 'builtin' }
        resolve(fallback)
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Retrieve original uncompressed content for a previously compressed section.
 * Calls the Python bridge rewind command with the given key.
 */
function rewind(pythonPath, key) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ key })
    const child = execFile(pythonPath, [COMPACTOR_SCRIPT, 'rewind'], {
      timeout: 10000,
    }, (err, stdout) => {
      if (err) return resolve({ found: false, error: 'Python bridge failed' })
      try {
        const result = JSON.parse(stdout)
        resolve(result)
      } catch {
        resolve({ found: false, error: 'Invalid response from bridge' })
      }
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Get compactor status/version info.
 * Includes rewind_enabled field from the Python bridge response.
 * Always reports installed since built-in fallback is available.
 */
function getStatus(pythonPath) {
  return new Promise(resolve => {
    execFile(pythonPath, [COMPACTOR_SCRIPT, 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: false })
      try {
        const result = JSON.parse(stdout)
        if (result.installed) return resolve({ ...result, engine: 'python' })
        resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: false })
      } catch { resolve({ installed: true, version: 'built-in', engine: 'builtin', rewind_enabled: false }) }
    })
  })
}

module.exports = { compressMessages, compressText, rewind, getStatus, checkInstalled }
