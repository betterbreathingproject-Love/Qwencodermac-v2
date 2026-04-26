'use strict'

// Feature: telegram-video-recording, Property 1: Recording filename matches pattern

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const { RecordingManager } = require('../recording-manager')

describe('RecordingManager property tests', () => {
  /**
   * Property 1: Recording filename matches pattern
   *
   * For any jobId string and format ("mp4" or "webm"), the generated filename
   * SHALL match the pattern recording_{timestamp}_{jobId}.{format} where
   * timestamp is a numeric value and the filename contains the exact jobId
   * and format provided.
   *
   * **Validates: Requirements 2.2**
   */
  it('Property 1: recording filename matches pattern', () => {
    const manager = new RecordingManager({ baseDir: '/tmp/prop-test-recordings' })

    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.constantFrom('mp4', 'webm'),
        (jobId, format) => {
          const filename = manager.generateFilename(jobId, format)

          // Must match the full pattern: recording_{digits}_{jobId}.{format}
          const expectedPattern = new RegExp(
            `^recording_\\d+_${escapeRegExp(jobId)}\\.${escapeRegExp(format)}$`
          )
          assert.match(
            filename,
            expectedPattern,
            `Filename "${filename}" should match pattern recording_{timestamp}_${jobId}.${format}`
          )

          // Timestamp portion must be a valid positive integer
          const parts = filename.split('_')
          const timestamp = Number(parts[1])
          assert.ok(
            Number.isInteger(timestamp) && timestamp > 0,
            `Timestamp "${parts[1]}" should be a positive integer`
          )

          // Filename must end with the exact format extension
          assert.ok(
            filename.endsWith(`.${format}`),
            `Filename should end with .${format}`
          )

          // Filename must contain the exact jobId
          assert.ok(
            filename.includes(`_${jobId}.`),
            `Filename should contain the jobId "${jobId}"`
          )
        }
      ),
      { numRuns: 150 }
    )
  })
})

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
