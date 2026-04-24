'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  PHASE_ORDER,
  initSpec,
  getSpecPhase,
  advancePhase,
} = require('../spec-workflow.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-wf-prop-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Generate a random number of advancePhase calls (0 to 6, covering beyond implementation).
 */
function arbitraryAdvanceCount() {
  return fc.integer({ min: 0, max: 6 });
}

/**
 * Generate a safe feature name for directory creation.
 */
function arbitraryFeatureName() {
  return fc
    .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter((s) => s.length > 0);
}

describe('Property-based tests for spec-workflow.js', () => {
  // 5.3.1 Property 10: Spec phase transition validity
  // **Validates: Requirements 6.6**
  it('Property 10: spec phase transition validity', () => {
    let counter = 0;
    fc.assert(
      fc.property(
        arbitraryFeatureName(),
        arbitraryAdvanceCount(),
        (featureName, advanceCount) => {
          // Use a unique sub-directory per iteration to avoid collisions
          const iterDir = path.join(tmpDir, `iter-${counter++}`);
          fs.mkdirSync(iterDir, { recursive: true });

          const { specDir } = initSpec(featureName, iterDir);

          // Initial phase must be 'requirements'
          assert.equal(getSpecPhase(specDir), 'requirements');

          let currentPhase = 'requirements';
          for (let i = 0; i < advanceCount; i++) {
            const newPhase = advancePhase(specDir);
            const currentIndex = PHASE_ORDER.indexOf(currentPhase);

            if (currentPhase === 'implementation') {
              // From implementation, phase should not change
              assert.equal(
                newPhase,
                'implementation',
                `advancePhase from implementation should stay at implementation, got ${newPhase}`
              );
            } else {
              // Should move to the next phase in sequence
              const expectedPhase = PHASE_ORDER[currentIndex + 1];
              assert.equal(
                newPhase,
                expectedPhase,
                `Expected phase ${expectedPhase} after advancing from ${currentPhase}, got ${newPhase}`
              );
            }

            // Verify getSpecPhase agrees
            assert.equal(getSpecPhase(specDir), newPhase);

            // The phase must always be a valid phase
            assert.ok(
              PHASE_ORDER.includes(newPhase),
              `Phase ${newPhase} is not a valid phase`
            );

            currentPhase = newPhase;
          }
        }
      ),
      { numRuns: 120 }
    );
  });
});
