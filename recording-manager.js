'use strict'

const fs = require('node:fs')
const path = require('node:path')

class RecordingManager {
  /**
   * @param {object} [options]
   * @param {string} [options.baseDir] - Base directory for recordings.
   *   Defaults to {app_data}/telegram-recordings/ when running inside Electron,
   *   or a fallback path in the current working directory otherwise.
   */
  constructor(options = {}) {
    if (options.baseDir) {
      this._baseDir = options.baseDir
    } else {
      try {
        const { app } = require('electron')
        this._baseDir = path.join(app.getPath('userData'), 'telegram-recordings')
      } catch {
        this._baseDir = path.join(process.cwd(), 'telegram-recordings')
      }
    }
  }

  /**
   * Generate a unique recording filename.
   * @param {string} jobId
   * @param {string} [format='webm'] - 'webm' or 'mp4'
   * @returns {string} e.g. 'recording_1719000000000_job123.webm'
   */
  generateFilename(jobId, format = 'webm') {
    const timestamp = Date.now()
    return `recording_${timestamp}_${jobId}.${format}`
  }

  /**
   * Get (and create if missing) the recording directory for a job.
   * @param {string} jobId
   * @returns {string} Full path to the job's recording directory
   */
  getRecordingDir(jobId) {
    const dir = path.join(this._baseDir, jobId, path.sep)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  /**
   * List all existing recordings across all job subdirectories.
   * @returns {Array<{ filePath: string, filename: string, sizeBytes: number, createdAt: Date }>}
   */
  listRecordings() {
    const results = []
    if (!fs.existsSync(this._baseDir)) return results

    const entries = fs.readdirSync(this._baseDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(this._baseDir, entry.name)
      if (entry.isDirectory()) {
        // Scan files inside job subdirectories
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile()) {
            const filePath = path.join(fullPath, sub.name)
            const stat = fs.statSync(filePath)
            results.push({
              filePath,
              filename: sub.name,
              sizeBytes: stat.size,
              createdAt: stat.birthtime,
            })
          }
        }
      } else if (entry.isFile()) {
        // Files directly in baseDir
        const stat = fs.statSync(fullPath)
        results.push({
          filePath: fullPath,
          filename: entry.name,
          sizeBytes: stat.size,
          createdAt: stat.birthtime,
        })
      }
    }
    return results
  }

  /**
   * Validate that a recording file exists and is readable.
   * @param {string} filePath
   * @returns {{ ok: true, sizeBytes: number } | { ok: false, error: string }}
   */
  validateRecording(filePath) {
    try {
      fs.accessSync(filePath, fs.constants.R_OK)
      const stat = fs.statSync(filePath)
      return { ok: true, sizeBytes: stat.size }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /**
   * Check if a recording file exceeds the 50 MB Telegram upload limit.
   * @param {string} filePath
   * @returns {{ withinLimit: boolean, sizeBytes: number }}
   */
  checkSizeLimit(filePath) {
    const MAX_SIZE = 50 * 1024 * 1024 // 50 MB
    const stat = fs.statSync(filePath)
    return {
      withinLimit: stat.size <= MAX_SIZE,
      sizeBytes: stat.size,
    }
  }
}

module.exports = { RecordingManager }
