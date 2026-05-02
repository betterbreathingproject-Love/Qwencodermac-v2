'use strict'

/**
 * Xcode project.pbxproj generator.
 *
 * Generates a valid project.pbxproj file from a directory of Swift source
 * files. Handles file references, build phases, groups, and targets.
 *
 * This is a mechanical task that doesn't need LLM intelligence — just
 * file enumeration and UUID generation.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * Generate a deterministic 24-char hex UUID for pbxproj.
 * Uses a hash of the input string for reproducibility.
 */
function pbxUUID(seed) {
  return crypto.createHash('md5').update(seed).digest('hex').slice(0, 24).toUpperCase()
}

/**
 * Scan a directory for Swift source files, asset catalogs, etc.
 * Returns arrays of categorized file paths (relative to sourceRoot).
 */
function scanProject(sourceRoot) {
  const swift = []
  const assets = []
  const plists = []
  const others = []

  function walk(dir, rel) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.endsWith('.xcassets')) {
          assets.push(relPath)
        } else {
          walk(full, relPath)
        }
      } else if (e.name.endsWith('.swift')) {
        swift.push(relPath)
      } else if (e.name.endsWith('.plist')) {
        plists.push(relPath)
      }
    }
  }

  walk(sourceRoot, '')
  return { swift, assets, plists, others }
}
