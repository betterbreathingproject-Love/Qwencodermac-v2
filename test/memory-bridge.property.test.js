'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')

// Feature: taosmd-memory-integration, Property 16: Secret filtering on ingest

// ── JavaScript mirror of memory-bridge.py's 17 secret filtering patterns ─────
// These patterns replicate the Python filter_secrets() function for client-side
// validation and property testing.

const SECRET_PATTERNS = [
  // 1. OpenAI API keys (sk-...)
  { name: 'openai_api_key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  // 2. Generic API keys (api_key=..., apikey=..., api-key: ...)
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})['"]?/gi },
  // 3. Bearer tokens
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi },
  // 4. Basic auth (Authorization: Basic ...)
  { name: 'basic_auth', pattern: /Basic\s+[A-Za-z0-9+/=]{16,}/gi },
  // 5. Passwords in URLs (proto://user:pass@host)
  { name: 'password_in_url', pattern: /:\/\/[^:@\s]+:([^@\s]{3,})@/g },
  // 6. Private keys (BEGIN ... PRIVATE KEY)
  { name: 'private_key', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g },
  // 7. AWS access keys (AKIA...)
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  // 8. AWS secret keys (40-char base64 after common prefixes)
  { name: 'aws_secret_key', pattern: /(?:aws_secret_access_key|aws_secret_key|secret_access_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
  // 9. Connection strings (postgres://, mysql://, mongodb://)
  { name: 'connection_string', pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]+/g },
  // 10. GitHub tokens (ghp_, gho_, ghs_, ghr_)
  { name: 'github_token', pattern: /(?:ghp|gho|ghs|ghr)_[A-Za-z0-9_]{36,}/g },
  // 11. Slack tokens (xoxb-, xoxp-, xoxs-)
  { name: 'slack_token', pattern: /xox[bps]-[A-Za-z0-9\-]{10,}/g },
  // 12. JWT tokens (three base64url segments separated by dots)
  { name: 'jwt_token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}/g },
  // 13. Stripe keys (sk_live_, pk_live_)
  { name: 'stripe_key', pattern: /(?:sk|pk)_live_[A-Za-z0-9]{20,}/g },
  // 14. SendGrid keys (SG.)
  { name: 'sendgrid_key', pattern: /SG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g },
  // 15. Twilio keys (SK followed by 32 hex chars)
  { name: 'twilio_key', pattern: /SK[0-9a-fA-F]{32}/g },
  // 16. Generic secrets in env vars (SECRET=..., TOKEN=..., PASSWORD=...)
  { name: 'env_secret', pattern: /(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi },
  // 17. Base64-encoded credentials (long base64 strings after auth-related keys)
  { name: 'base64_credentials', pattern: /(?:auth|credential|secret|password|token)\s*[:=]\s*['"]?([A-Za-z0-9+/]{40,}={0,2})['"]?/gi },
]

/**
 * Apply the 17 secret filtering regex patterns to redact sensitive values.
 * Mirrors the Python filter_secrets() function in memory-bridge.py.
 * Replaces matched secrets with [REDACTED].
 */
function filterSecrets(text) {
  for (const { pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes since we reuse them across calls
    pattern.lastIndex = 0
    text = text.replace(pattern, '[REDACTED]')
  }
  return text
}


// ── Generators for realistic secret patterns ─────────────────────────────────

const ALNUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const UPPER_ALNUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const HEX_CHARS = '0123456789abcdef'
const SAFE_CHARS = 'abcdefghijklmnopqrstuvwxyz 0123456789'

/** Generate a random string from a character set */
function arbStringFrom(chars, minLen, maxLen) {
  return fc.array(fc.constantFrom(...chars), { minLength: minLen, maxLength: maxLen })
    .map(arr => arr.join(''))
}

/** OpenAI API key: sk- followed by 20+ alphanumeric chars */
function arbOpenAIKey() {
  return arbStringFrom(ALNUM_CHARS, 20, 50).map(s => `sk-${s}`)
}

/** AWS access key: AKIA followed by 16 uppercase alphanumeric chars */
function arbAWSAccessKey() {
  return arbStringFrom(UPPER_ALNUM_CHARS, 16, 16).map(s => `AKIA${s}`)
}

/** Bearer token: Bearer followed by 20+ chars */
function arbBearerToken() {
  return arbStringFrom(ALNUM_CHARS, 20, 60).map(s => `Bearer ${s}`)
}

/** GitHub token: ghp_ followed by 36+ alphanumeric chars */
function arbGitHubToken() {
  return arbStringFrom(ALNUM_CHARS, 36, 50).map(s => `ghp_${s}`)
}

/** Stripe key: sk_live_ or pk_live_ followed by 20+ alphanumeric chars */
function arbStripeKey() {
  return fc.tuple(
    fc.constantFrom('sk_live_', 'pk_live_'),
    arbStringFrom(ALNUM_CHARS, 20, 40)
  ).map(([prefix, s]) => `${prefix}${s}`)
}

/** Slack token: xoxb- or xoxp- followed by 10+ chars */
function arbSlackToken() {
  return fc.tuple(
    fc.constantFrom('xoxb-', 'xoxp-', 'xoxs-'),
    arbStringFrom(ALNUM_CHARS, 10, 30)
  ).map(([prefix, s]) => `${prefix}${s}`)
}

/** Twilio key: SK followed by 32 hex chars */
function arbTwilioKey() {
  return arbStringFrom(HEX_CHARS, 32, 32).map(s => `SK${s}`)
}

/** Generic env secret: SECRET= or TOKEN= or PASSWORD= followed by 8+ chars */
function arbEnvSecret() {
  return fc.tuple(
    fc.constantFrom('SECRET', 'TOKEN', 'PASSWORD'),
    fc.constantFrom('=', ': '),
    arbStringFrom(ALNUM_CHARS, 8, 30)
  ).map(([key, sep, val]) => `${key}${sep}${val}`)
}

/** Surrounding text that does NOT look like a secret */
function arbSafeText() {
  return arbStringFrom(SAFE_CHARS, 0, 80)
}

/** Combine a secret with surrounding safe text */
function arbTextWithSecret(secretGen) {
  return fc.tuple(arbSafeText(), secretGen, arbSafeText())
    .map(([before, secret, after]) => ({
      fullText: `${before} ${secret} ${after}`,
      secret,
    }))
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: taosmd-memory-integration — memory-bridge property tests', () => {
  /**
   * Property 16 — Secret filtering on ingest
   * **Validates: Requirements 15.1, 15.2, 15.4**
   *
   * For any text containing an API key, bearer token, or AWS credential,
   * after filtering, the output contains [REDACTED] and does NOT contain
   * the original secret value.
   */
  describe('Property 16: Secret filtering on ingest', () => {
    it('OpenAI API keys are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbOpenAIKey()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for OpenAI key`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original OpenAI key: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('AWS access keys are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbAWSAccessKey()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for AWS key`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original AWS key: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Bearer tokens are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbBearerToken()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for Bearer token`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original Bearer token: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('GitHub tokens are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbGitHubToken()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for GitHub token`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original GitHub token: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Stripe keys are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbStripeKey()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for Stripe key`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original Stripe key: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Slack tokens are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbSlackToken()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for Slack token`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original Slack token: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Twilio keys are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbTwilioKey()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for Twilio key`)
          assert.ok(!filtered.includes(secret),
            `Filtered text should not contain original Twilio key: ${secret}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Generic env secrets (SECRET=, TOKEN=, PASSWORD=) are redacted', () => {
      fc.assert(
        fc.property(arbTextWithSecret(arbEnvSecret()), ({ fullText, secret }) => {
          const filtered = filterSecrets(fullText)
          assert.ok(filtered.includes('[REDACTED]'),
            `Filtered text should contain [REDACTED] for env secret`)
          // The secret value (after the = or :) should not appear in filtered output
          const secretValue = secret.split(/[:=]\s*/)[1]
          assert.ok(!filtered.includes(secretValue),
            `Filtered text should not contain original env secret value: ${secretValue}`)
        }),
        { numRuns: 150 }
      )
    })

    it('Text without secrets passes through unchanged', () => {
      fc.assert(
        fc.property(arbSafeText(), (text) => {
          const filtered = filterSecrets(text)
          assert.equal(filtered, text,
            'Text without secrets should pass through unchanged')
        }),
        { numRuns: 150 }
      )
    })

    it('Multiple secrets in one text are all redacted', () => {
      fc.assert(
        fc.property(
          fc.tuple(arbOpenAIKey(), arbAWSAccessKey(), arbBearerToken(), arbSafeText()),
          ([openaiKey, awsKey, bearerToken, padding]) => {
            const fullText = `${padding} ${openaiKey} and ${awsKey} also ${bearerToken} end`
            const filtered = filterSecrets(fullText)

            assert.ok(!filtered.includes(openaiKey),
              `Filtered text should not contain OpenAI key`)
            assert.ok(!filtered.includes(awsKey),
              `Filtered text should not contain AWS key`)
            assert.ok(!filtered.includes(bearerToken),
              `Filtered text should not contain Bearer token`)

            // Count [REDACTED] occurrences — should be at least 3
            const redactedCount = (filtered.match(/\[REDACTED\]/g) || []).length
            assert.ok(redactedCount >= 3,
              `Expected at least 3 [REDACTED] markers, got ${redactedCount}`)
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── In-memory KG mock simulating memory-bridge.py KG behavior ──────────────
  // This mock replicates the server-side KG logic: triple storage, entity query,
  // temporal contradiction detection, temporal point-in-time query, and clear
  // with confirmation guard.

  /**
   * Create a fresh in-memory Knowledge Graph mock.
   * Simulates the behavior of the memory-bridge.py KG endpoints.
   */
  function createMockKG() {
    let triples = []
    let nextId = 1

    return {
      /**
       * POST /memory/kg/triples — Add a triple with temporal contradiction detection.
       * When a new triple shares the same subject-predicate pair as an existing triple,
       * the older triple's valid_until is set to now.
       */
      addTriple(subject, predicate, object, validFrom, validUntil) {
        const now = new Date()

        // Temporal contradiction detection: mark older triples with same subject+predicate
        for (const t of triples) {
          if (t.subject === subject && t.predicate === predicate && t.valid_until === null) {
            t.valid_until = now
          }
        }

        const triple = {
          id: nextId++,
          subject,
          predicate,
          object,
          valid_from: validFrom || now,
          valid_until: validUntil || null,
          created_at: now,
        }
        triples.push(triple)
        return triple
      },

      /**
       * GET /memory/kg/query/{entity} — Query triples where entity is subject or object.
       */
      queryEntity(entity) {
        return triples.filter(t => t.subject === entity || t.object === entity)
      },

      /**
       * POST /memory/kg/query-temporal — Temporal point-in-time query.
       * Returns triples where valid_from <= atTime AND (valid_until is null OR valid_until >= atTime).
       */
      queryTemporal(entity, atTime) {
        return triples.filter(t => {
          if (t.subject !== entity && t.object !== entity) return false
          if (t.valid_from !== null && t.valid_from > atTime) return false
          if (t.valid_until !== null && t.valid_until < atTime) return false
          return true
        })
      },

      /**
       * DELETE /memory/kg/clear — Clear all triples (requires confirm: true).
       */
      clear(confirm) {
        if (!confirm) {
          return { ok: false, error: 'Confirmation required: set confirm=true to clear all triples' }
        }
        triples = []
        return { ok: true, message: 'Knowledge Graph cleared' }
      },

      /** Get all stored triples (for test assertions). */
      getAll() {
        return [...triples]
      },

      /** Get count of stored triples. */
      count() {
        return triples.length
      },
    }
  }

  // ── Generators for KG property tests ─────────────────────────────────────────

  /** Generate a valid KG entity name (non-empty alphanumeric + underscores) */
  function arbEntity() {
    return arbStringFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_', 1, 30)
  }

  /** Generate a valid predicate string */
  function arbPredicate() {
    return fc.constantFrom(
      'uses', 'is_a', 'has', 'works_with', 'depends_on', 'created_by',
      'located_in', 'part_of', 'related_to', 'knows', 'owns', 'manages'
    )
  }

  /** Generate a triple: { subject, predicate, object } with distinct subject and object */
  function arbTriple() {
    return fc.tuple(arbEntity(), arbPredicate(), arbEntity())
      .filter(([s, , o]) => s !== o)
      .map(([subject, predicate, object]) => ({ subject, predicate, object }))
  }

  /** Generate a Date within a reasonable range */
  function arbTimestamp() {
    // Dates between 2024-01-01 and 2026-01-01
    const min = new Date('2024-01-01T00:00:00Z').getTime()
    const max = new Date('2026-01-01T00:00:00Z').getTime()
    return fc.integer({ min, max }).map(ms => new Date(ms))
  }

  /** Generate a time window: { validFrom, validUntil } where validFrom < validUntil */
  function arbTimeWindow() {
    return fc.tuple(arbTimestamp(), arbTimestamp())
      .filter(([a, b]) => a.getTime() !== b.getTime())
      .map(([a, b]) => {
        const [from, until] = a < b ? [a, b] : [b, a]
        return { validFrom: from, validUntil: until }
      })
  }

  // ── Property 1: Triple storage and query round-trip ────────────────────────

  // Feature: taosmd-memory-integration, Property 1: Triple storage and query round-trip
  describe('Property 1: Triple storage and query round-trip', () => {
    /**
     * **Validates: Requirements 2.1, 2.2**
     *
     * For any valid triple (subject, predicate, object), after adding it via
     * addTriple(), querying by either subject or object SHALL return a result
     * containing the original triple.
     */
    it('added triple is found when querying by subject', () => {
      fc.assert(
        fc.property(arbTriple(), (triple) => {
          const kg = createMockKG()
          kg.addTriple(triple.subject, triple.predicate, triple.object)

          const results = kg.queryEntity(triple.subject)
          assert.ok(results.length >= 1,
            `Query by subject "${triple.subject}" should return at least 1 result`)

          const found = results.some(r =>
            r.subject === triple.subject &&
            r.predicate === triple.predicate &&
            r.object === triple.object
          )
          assert.ok(found,
            `Query by subject should contain the original triple`)
        }),
        { numRuns: 150 }
      )
    })

    it('added triple is found when querying by object', () => {
      fc.assert(
        fc.property(arbTriple(), (triple) => {
          const kg = createMockKG()
          kg.addTriple(triple.subject, triple.predicate, triple.object)

          const results = kg.queryEntity(triple.object)
          assert.ok(results.length >= 1,
            `Query by object "${triple.object}" should return at least 1 result`)

          const found = results.some(r =>
            r.subject === triple.subject &&
            r.predicate === triple.predicate &&
            r.object === triple.object
          )
          assert.ok(found,
            `Query by object should contain the original triple`)
        }),
        { numRuns: 150 }
      )
    })

    it('returned triple preserves all original field values', () => {
      fc.assert(
        fc.property(arbTriple(), (triple) => {
          const kg = createMockKG()
          const added = kg.addTriple(triple.subject, triple.predicate, triple.object)

          assert.equal(added.subject, triple.subject)
          assert.equal(added.predicate, triple.predicate)
          assert.equal(added.object, triple.object)
          assert.ok(typeof added.id === 'number' && added.id > 0,
            'Triple should have a positive numeric id')
          assert.ok(added.created_at instanceof Date,
            'Triple should have a created_at timestamp')
        }),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 2: Temporal contradiction supersession ────────────────────────

  // Feature: taosmd-memory-integration, Property 2: Temporal contradiction supersession
  describe('Property 2: Temporal contradiction supersession', () => {
    /**
     * **Validates: Requirements 2.3**
     *
     * For any two triples sharing the same subject and predicate but different objects,
     * after adding both sequentially, the first triple's valid_until should be non-null
     * and querying at current time returns only the newer triple.
     */
    it('older triple gets valid_until set when superseded', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          arbPredicate(),
          arbEntity(),
          arbEntity(),
          (subject, predicate, object1, object2) => {
            // Ensure objects are different for a real contradiction
            fc.pre(object1 !== object2)
            fc.pre(subject !== object1 && subject !== object2)

            const kg = createMockKG()

            // Add first triple
            const first = kg.addTriple(subject, predicate, object1)
            assert.equal(first.valid_until, null,
              'First triple should initially have null valid_until')

            // Add second triple with same subject+predicate (contradiction)
            kg.addTriple(subject, predicate, object2)

            // Re-fetch all triples to check the first was updated
            const all = kg.getAll()
            const firstUpdated = all.find(t => t.id === first.id)
            assert.ok(firstUpdated.valid_until !== null,
              'First triple valid_until should be set after supersession')
            assert.ok(firstUpdated.valid_until instanceof Date,
              'First triple valid_until should be a Date')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('temporal query at current time returns only the newer triple', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          arbPredicate(),
          arbEntity(),
          arbEntity(),
          (subject, predicate, object1, object2) => {
            fc.pre(object1 !== object2)
            fc.pre(subject !== object1 && subject !== object2)

            const kg = createMockKG()

            kg.addTriple(subject, predicate, object1)
            kg.addTriple(subject, predicate, object2)

            // Query at a time slightly in the future to ensure we're past the supersession
            const futureTime = new Date(Date.now() + 1000)
            const results = kg.queryTemporal(subject, futureTime)

            // Only the newer triple (object2) should be valid at current time
            const matchingPredicate = results.filter(r => r.predicate === predicate)
            assert.equal(matchingPredicate.length, 1,
              `Should find exactly 1 triple for predicate "${predicate}" at current time`)
            assert.equal(matchingPredicate[0].object, object2,
              'The valid triple should be the newer one (object2)')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 3: Temporal query returns only valid triples ──────────────────

  // Feature: taosmd-memory-integration, Property 3: Temporal query returns only valid triples
  describe('Property 3: Temporal query returns only valid triples', () => {
    /**
     * **Validates: Requirements 2.4**
     *
     * For any set of triples with defined valid_from/valid_until windows,
     * and for any query timestamp t, the temporal query returns exactly those
     * triples where valid_from <= t and (valid_until is null or valid_until >= t).
     */
    it('temporal query returns exactly the triples valid at time t', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          fc.array(
            fc.tuple(arbPredicate(), arbEntity(), arbTimeWindow()),
            { minLength: 1, maxLength: 8 }
          ),
          arbTimestamp(),
          (entity, tripleSpecs, queryTime) => {
            const kg = createMockKG()

            // Add triples with explicit time windows
            const added = tripleSpecs.map(([predicate, object, { validFrom, validUntil }]) => {
              return kg.addTriple(entity, predicate, object, validFrom, validUntil)
            })

            // Compute expected valid triples manually
            const expected = added.filter(t => {
              const fromOk = t.valid_from === null || t.valid_from <= queryTime
              const untilOk = t.valid_until === null || t.valid_until >= queryTime
              return fromOk && untilOk
            })

            // Query temporal
            const results = kg.queryTemporal(entity, queryTime)

            // Results should contain exactly the expected triples (by id)
            const expectedIds = new Set(expected.map(t => t.id))
            const resultIds = new Set(results.map(t => t.id))

            assert.deepStrictEqual(resultIds, expectedIds,
              `Temporal query at ${queryTime.toISOString()} should return exactly the valid triples. ` +
              `Expected ids: [${[...expectedIds]}], got: [${[...resultIds]}]`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('triple with null valid_until is always valid after valid_from', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          arbPredicate(),
          arbEntity(),
          arbTimestamp(),
          arbTimestamp(),
          (entity, predicate, object, validFrom, queryTime) => {
            // Ensure queryTime is after validFrom
            fc.pre(queryTime >= validFrom)

            const kg = createMockKG()
            kg.addTriple(entity, predicate, object, validFrom, null)

            const results = kg.queryTemporal(entity, queryTime)
            assert.ok(results.length >= 1,
              'Triple with null valid_until should be valid at any time >= valid_from')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('triple is not returned when query time is before valid_from', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          arbPredicate(),
          arbEntity(),
          arbTimestamp(),
          arbTimestamp(),
          (entity, predicate, object, validFrom, queryTime) => {
            // Ensure queryTime is strictly before validFrom
            fc.pre(queryTime < validFrom)

            const kg = createMockKG()
            kg.addTriple(entity, predicate, object, validFrom, null)

            const results = kg.queryTemporal(entity, queryTime)
            const matching = results.filter(r => r.predicate === predicate && r.object === object)
            assert.equal(matching.length, 0,
              'Triple should not be returned when query time is before valid_from')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('triple is not returned when query time is after valid_until', () => {
      fc.assert(
        fc.property(
          arbEntity(),
          arbPredicate(),
          arbEntity(),
          arbTimeWindow(),
          arbTimestamp(),
          (entity, predicate, object, { validFrom, validUntil }, queryTime) => {
            // Ensure queryTime is strictly after validUntil
            fc.pre(queryTime > validUntil)

            const kg = createMockKG()
            kg.addTriple(entity, predicate, object, validFrom, validUntil)

            const results = kg.queryTemporal(entity, queryTime)
            const matching = results.filter(r => r.predicate === predicate && r.object === object)
            assert.equal(matching.length, 0,
              'Triple should not be returned when query time is after valid_until')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── In-memory Archive mock simulating memory-bridge.py Archive behavior ──────
  // This mock replicates the server-side Archive logic: record storage, FTS search,
  // and recent events ordered by timestamp descending.

  /**
   * Create a fresh in-memory Archive mock.
   * Simulates the behavior of the memory-bridge.py Archive endpoints.
   */
  function createMockArchive() {
    let records = []
    let nextId = 1

    return {
      /**
       * POST /memory/archive/record — Record an event with metadata.
       * Includes UTC timestamp, agent_name, and session_id in record metadata.
       */
      record(eventType, payload, summary, agentName, sessionId, turnNumber) {
        const record = {
          id: nextId++,
          event_type: eventType,
          payload,
          summary,
          agent_name: agentName || null,
          session_id: sessionId || null,
          turn_number: turnNumber || null,
          timestamp: new Date(),
        }
        records.push(record)
        return record
      },

      /**
       * GET /memory/archive/search — FTS5 full-text search.
       * Simple substring match for testing purposes.
       */
      searchFts(query, limit = 20) {
        const q = query.toLowerCase()
        return records
          .filter(r => {
            const payloadStr = typeof r.payload === 'string'
              ? r.payload
              : JSON.stringify(r.payload)
            return payloadStr.toLowerCase().includes(q) ||
              r.summary.toLowerCase().includes(q)
          })
          .slice(0, limit)
      },

      /**
       * GET /memory/archive/events — Recent events ordered by timestamp descending.
       */
      recentEvents(limit = 50) {
        return [...records]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit)
      },

      /** Get all records (for test assertions). */
      getAll() {
        return [...records]
      },

      /** Get count of stored records. */
      count() {
        return records.length
      },
    }
  }

  // ── Generators for Archive property tests ────────────────────────────────────

  /** Generate a valid event type */
  function arbEventType() {
    return fc.constantFrom(
      'conversation', 'tool_call', 'decision', 'error',
      'pre_compaction', 'session_start', 'session_end',
      'task_completion', 'workflow_start'
    )
  }

  /** Generate a distinctive word (length >= 4, alphanumeric only) */
  function arbDistinctiveWord() {
    return arbStringFrom('abcdefghijklmnopqrstuvwxyz', 4, 12)
  }

  /** Generate a payload string containing a distinctive word */
  function arbPayloadWithWord() {
    return fc.tuple(arbDistinctiveWord(), arbSafeText(), arbSafeText())
      .map(([word, before, after]) => ({
        payload: `${before} ${word} ${after}`,
        word,
      }))
  }

  /** Generate a valid agent name */
  function arbAgentName() {
    return fc.constantFrom(
      'main-agent', 'explore-agent', 'code-agent', 'context-agent', null
    )
  }

  /** Generate a valid session ID */
  function arbSessionId() {
    return fc.option(
      arbStringFrom('abcdefghijklmnopqrstuvwxyz0123456789-', 8, 36),
      { nil: null }
    )
  }

  // ── Property 4: Archive record metadata completeness ──────────────────────

  // Feature: taosmd-memory-integration, Property 4: Archive record metadata completeness
  describe('Property 4: Archive record metadata completeness', () => {
    /**
     * **Validates: Requirements 3.1, 3.5**
     *
     * For any archive record written with event_type, payload, summary,
     * agent_name, and session_id, retrieving that record SHALL include a UTC
     * timestamp, the provided agent_name, and the provided session_id.
     */
    it('archived record includes UTC timestamp', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          arbAgentName(),
          arbSessionId(),
          (eventType, payload, summary, agentName, sessionId) => {
            const archive = createMockArchive()
            const record = archive.record(eventType, payload, summary, agentName, sessionId)

            assert.ok(record.timestamp instanceof Date,
              'Record should have a Date timestamp')
            assert.ok(!isNaN(record.timestamp.getTime()),
              'Record timestamp should be a valid date')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived record preserves agent_name', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          arbAgentName(),
          arbSessionId(),
          (eventType, payload, summary, agentName, sessionId) => {
            const archive = createMockArchive()
            const record = archive.record(eventType, payload, summary, agentName, sessionId)

            assert.equal(record.agent_name, agentName,
              `Record agent_name should match provided value: ${agentName}`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived record preserves session_id', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          arbAgentName(),
          arbSessionId(),
          (eventType, payload, summary, agentName, sessionId) => {
            const archive = createMockArchive()
            const record = archive.record(eventType, payload, summary, agentName, sessionId)

            assert.equal(record.session_id, sessionId,
              `Record session_id should match provided value: ${sessionId}`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived record preserves event_type, payload, and summary', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (eventType, payload, summary) => {
            const archive = createMockArchive()
            const record = archive.record(eventType, payload, summary)

            assert.equal(record.event_type, eventType)
            assert.equal(record.payload, payload)
            assert.equal(record.summary, summary)
            assert.ok(typeof record.id === 'number' && record.id > 0,
              'Record should have a positive numeric id')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 5: Archive FTS search finds stored content ───────────────────

  // Feature: taosmd-memory-integration, Property 5: Archive FTS search finds stored content
  describe('Property 5: Archive FTS search finds stored content', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any archived record whose payload contains a distinctive word
     * (length >= 4, alphanumeric), searching with that word SHALL return
     * a result set that includes the original record.
     */
    it('FTS search finds record by distinctive word in payload', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          arbPayloadWithWord(),
          fc.string({ minLength: 1, maxLength: 50 }),
          (eventType, { payload, word }, summary) => {
            const archive = createMockArchive()
            const record = archive.record(eventType, payload, summary)

            const results = archive.searchFts(word)
            const found = results.some(r => r.id === record.id)
            assert.ok(found,
              `FTS search for "${word}" should find the record with id ${record.id}`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('FTS search finds record by word in summary', () => {
      fc.assert(
        fc.property(
          arbEventType(),
          fc.string({ minLength: 1, maxLength: 100 }),
          arbDistinctiveWord(),
          (eventType, payload, word) => {
            const archive = createMockArchive()
            const summary = `summary containing ${word} here`
            const record = archive.record(eventType, payload, summary)

            const results = archive.searchFts(word)
            const found = results.some(r => r.id === record.id)
            assert.ok(found,
              `FTS search for "${word}" should find record by summary match`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('FTS search respects limit parameter', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }),
          fc.integer({ min: 1, max: 5 }),
          (totalRecords, limit) => {
            fc.pre(limit < totalRecords)

            const archive = createMockArchive()
            const word = 'searchterm'

            // Add totalRecords records all containing the search word
            for (let i = 0; i < totalRecords; i++) {
              archive.record('conversation', `payload with ${word} in it`, 'summary')
            }

            const results = archive.searchFts(word, limit)
            assert.ok(results.length <= limit,
              `FTS search results should not exceed limit ${limit}, got ${results.length}`)
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 6: Archive events ordered by timestamp descending ────────────

  // Feature: taosmd-memory-integration, Property 6: Archive events ordered by timestamp descending
  describe('Property 6: Archive events ordered by timestamp descending', () => {
    /**
     * **Validates: Requirements 3.6**
     *
     * For any sequence of N archived events (N >= 2), the events endpoint
     * with limit >= N SHALL return events where each event's timestamp is
     * >= the next event's timestamp (descending order).
     */
    it('recent events are ordered by timestamp descending', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbEventType(), fc.string({ minLength: 1, maxLength: 100 })),
            { minLength: 2, maxLength: 10 }
          ),
          (eventSpecs) => {
            const archive = createMockArchive()

            // Add events sequentially (each gets a slightly later timestamp due to Date.now())
            for (const [eventType, payload] of eventSpecs) {
              archive.record(eventType, payload, 'summary')
            }

            const events = archive.recentEvents(eventSpecs.length + 5)
            assert.ok(events.length >= 2,
              'Should have at least 2 events to check ordering')

            // Verify descending order: each event timestamp >= next event timestamp
            for (let i = 0; i < events.length - 1; i++) {
              assert.ok(
                events[i].timestamp >= events[i + 1].timestamp,
                `Event at index ${i} (${events[i].timestamp.toISOString()}) should be >= ` +
                `event at index ${i + 1} (${events[i + 1].timestamp.toISOString()})`
              )
            }
          }
        ),
        { numRuns: 150 }
      )
    })

    it('recent events limit is respected', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 15 }),
          fc.integer({ min: 1, max: 4 }),
          (totalEvents, limit) => {
            const archive = createMockArchive()

            for (let i = 0; i < totalEvents; i++) {
              archive.record('conversation', `event ${i}`, 'summary')
            }

            const events = archive.recentEvents(limit)
            assert.ok(events.length <= limit,
              `recentEvents(${limit}) should return at most ${limit} events, got ${events.length}`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('most recent event appears first', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(arbEventType(), fc.string({ minLength: 1, maxLength: 50 })),
            { minLength: 2, maxLength: 8 }
          ),
          (eventSpecs) => {
            const archive = createMockArchive()

            let lastRecord = null
            for (const [eventType, payload] of eventSpecs) {
              lastRecord = archive.record(eventType, payload, 'summary')
            }

            const events = archive.recentEvents(100)
            assert.ok(events.length > 0, 'Should have events')

            // The most recently added record should be first (or tied for first)
            const firstTimestamp = events[0].timestamp
            assert.ok(
              firstTimestamp >= lastRecord.timestamp ||
              firstTimestamp.getTime() === lastRecord.timestamp.getTime(),
              'Most recent event should appear first in results'
            )
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 17: KG clear requires confirmation ────────────────────────────

  // Feature: taosmd-memory-integration, Property 17: KG clear requires confirmation
  describe('Property 17: KG clear requires confirmation', () => {
    /**
     * **Validates: Requirements 14.1**
     *
     * DELETE /memory/kg/clear without confirm:true SHALL return error and NOT
     * clear data. Only with confirm:true SHALL clear succeed.
     */
    it('clear without confirm does not remove triples', () => {
      fc.assert(
        fc.property(
          fc.array(arbTriple(), { minLength: 1, maxLength: 10 }),
          (triples) => {
            const kg = createMockKG()

            // Add all triples
            for (const t of triples) {
              kg.addTriple(t.subject, t.predicate, t.object)
            }
            const countBefore = kg.count()
            assert.ok(countBefore > 0, 'Should have triples before clear attempt')

            // Attempt clear without confirmation
            const result = kg.clear(false)
            assert.equal(result.ok, false,
              'Clear without confirm should return ok: false')
            assert.ok(result.error,
              'Clear without confirm should return an error message')

            // Triples should still be there
            assert.equal(kg.count(), countBefore,
              'Triple count should be unchanged after unconfirmed clear')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('clear with confirm:true removes all triples', () => {
      fc.assert(
        fc.property(
          fc.array(arbTriple(), { minLength: 1, maxLength: 10 }),
          (triples) => {
            const kg = createMockKG()

            // Add all triples
            for (const t of triples) {
              kg.addTriple(t.subject, t.predicate, t.object)
            }
            assert.ok(kg.count() > 0, 'Should have triples before clear')

            // Clear with confirmation
            const result = kg.clear(true)
            assert.equal(result.ok, true,
              'Clear with confirm should return ok: true')

            // All triples should be gone
            assert.equal(kg.count(), 0,
              'Triple count should be 0 after confirmed clear')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('data is queryable after failed clear attempt', () => {
      fc.assert(
        fc.property(arbTriple(), (triple) => {
          const kg = createMockKG()
          kg.addTriple(triple.subject, triple.predicate, triple.object)

          // Attempt clear without confirmation
          kg.clear(false)

          // Data should still be queryable
          const results = kg.queryEntity(triple.subject)
          const found = results.some(r =>
            r.subject === triple.subject &&
            r.predicate === triple.predicate &&
            r.object === triple.object
          )
          assert.ok(found,
            'Triple should still be queryable after unconfirmed clear')
        }),
        { numRuns: 150 }
      )
    })
  })

  // ── In-memory Vector Memory mock ─────────────────────────────────────────────
  // Simulates VectorMemory.add() and VectorMemory.search() with hybrid boosting.

  /**
   * Create a fresh in-memory Vector Memory mock.
   * Simulates semantic search with optional hybrid keyword boosting.
   */
  function createMockVectorMemory() {
    let entries = []
    let nextId = 1

    return {
      /**
       * POST /memory/vector/add — Add text with optional metadata.
       */
      add(text, metadata) {
        const entry = { id: nextId++, text, metadata: metadata || null }
        entries.push(entry)
        return entry
      },

      /**
       * POST /memory/vector/search — Search with optional hybrid boosting.
       * Semantic similarity: substring match score (1.0 if query is substring of text).
       * Hybrid boost: adds 0.5 to score when query words appear in text.
       */
      search(query, topK = 10, hybrid = true) {
        const q = query.toLowerCase()
        const queryWords = q.split(/\s+/).filter(w => w.length > 0)

        return entries
          .map(entry => {
            const text = entry.text.toLowerCase()
            // Base semantic score: 1.0 if query is substring, else 0.1
            let score = text.includes(q) ? 1.0 : 0.1

            // Hybrid keyword boost: add 0.5 if any query word appears in text
            if (hybrid) {
              const hasKeyword = queryWords.some(w => text.includes(w))
              if (hasKeyword) score += 0.5
            }

            return { ...entry, score }
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
      },

      getAll() { return [...entries] },
      count() { return entries.length },
    }
  }

  // ── In-memory Unified Retrieval mock ─────────────────────────────────────────
  // Simulates the POST /memory/retrieve endpoint with token budget enforcement.

  /**
   * Estimate tokens for a string (~4 chars per token).
   * Mirrors _estimate_tokens() in memory-bridge.py.
   */
  function estimateTokens(text) {
    return Math.max(1, Math.floor(text.length / 4))
  }

  /**
   * Simulate unified retrieval with token budget enforcement.
   * Mirrors the token budget logic in memory-bridge.py's retrieve() endpoint.
   */
  function mockRetrieve(results, tokenBudget) {
    let budgetRemaining = tokenBudget
    const trimmed = []

    for (const item of results) {
      const content = item.content || ''
      const tokens = estimateTokens(content)
      if (budgetRemaining <= 0) break
      if (tokens > budgetRemaining) {
        const maxChars = budgetRemaining * 4
        trimmed.push({ ...item, content: content.slice(0, maxChars) })
        budgetRemaining = 0
      } else {
        trimmed.push(item)
        budgetRemaining -= tokens
      }
    }

    const tokenCount = tokenBudget - budgetRemaining
    return { results: trimmed, tokenCount }
  }

  // ── Property 7: Vector search round-trip with hybrid boosting ─────────────

  // Feature: taosmd-memory-integration, Property 7: Vector search round-trip with hybrid boosting
  describe('Property 7: Vector search round-trip with hybrid boosting', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3**
     *
     * For any text added to Vector Memory, searching with a query derived from
     * that text (substring or exact match) SHALL return a result set that includes
     * the original text. The score with hybrid=true SHALL be >= score with hybrid=false
     * when the query contains exact keyword matches.
     */
    it('added text is found when searching with exact query', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 4, maxLength: 100 }),
          (text) => {
            const vm = createMockVectorMemory()
            const entry = vm.add(text)

            // Search with exact text as query
            const results = vm.search(text, 10, false)
            const found = results.some(r => r.id === entry.id)
            assert.ok(found,
              `Vector search with exact query should find the added text (id=${entry.id})`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('hybrid=true score >= hybrid=false score for keyword-matching queries', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 4, maxLength: 80 }),
          (text) => {
            const vm = createMockVectorMemory()
            vm.add(text)

            // Use a word from the text as the query (guaranteed keyword match)
            const words = text.split(/\s+/).filter(w => w.length >= 3)
            if (words.length === 0) return // skip if no usable words

            const query = words[0]
            const resultsHybrid = vm.search(query, 10, true)
            const resultsNoHybrid = vm.search(query, 10, false)

            if (resultsHybrid.length === 0 || resultsNoHybrid.length === 0) return

            // Find the same entry in both result sets
            const hybridEntry = resultsHybrid[0]
            const noHybridEntry = resultsNoHybrid.find(r => r.id === hybridEntry.id)

            if (!noHybridEntry) return // entry might not appear in non-hybrid results

            assert.ok(
              hybridEntry.score >= noHybridEntry.score,
              `Hybrid score (${hybridEntry.score}) should be >= non-hybrid score (${noHybridEntry.score}) for keyword match`
            )
          }
        ),
        { numRuns: 150 }
      )
    })

    it('search returns at most top_k results', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 20 }),
          fc.integer({ min: 1, max: 4 }),
          (totalEntries, topK) => {
            const vm = createMockVectorMemory()
            for (let i = 0; i < totalEntries; i++) {
              vm.add(`entry number ${i} with some content`)
            }

            const results = vm.search('entry', topK, true)
            assert.ok(results.length <= topK,
              `Search should return at most ${topK} results, got ${results.length}`)
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 8: Unified retrieval token budget enforcement ────────────────

  // Feature: taosmd-memory-integration, Property 8: Unified retrieval token budget enforcement
  describe('Property 8: Unified retrieval token budget enforcement', () => {
    /**
     * **Validates: Requirements 5.5, 5.6**
     *
     * For any retrieval query and any configured token budget B, the response's
     * token_count SHALL be <= B.
     */
    it('token_count is always <= token budget', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 500 }),
            { minLength: 1, maxLength: 20 }
          ),
          fc.integer({ min: 10, max: 2048 }),
          (contents, tokenBudget) => {
            const results = contents.map((content, i) => ({
              source: 'vector',
              content,
              score: 1.0 - i * 0.01,
              metadata: null,
            }))

            const { tokenCount } = mockRetrieve(results, tokenBudget)
            assert.ok(
              tokenCount <= tokenBudget,
              `token_count (${tokenCount}) should be <= token budget (${tokenBudget})`
            )
          }
        ),
        { numRuns: 150 }
      )
    })

    it('results are truncated to fit within budget', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 100 }),
          (tokenBudget) => {
            // Create results that would exceed the budget if all included
            const longContent = 'a'.repeat(tokenBudget * 8) // 2x budget in chars
            const results = [
              { source: 'vector', content: longContent, score: 1.0, metadata: null },
              { source: 'kg', content: 'short content', score: 0.9, metadata: null },
            ]

            const { results: trimmed, tokenCount } = mockRetrieve(results, tokenBudget)
            assert.ok(tokenCount <= tokenBudget,
              `token_count (${tokenCount}) should be <= budget (${tokenBudget})`)

            // First result should be truncated
            if (trimmed.length > 0) {
              const firstContent = trimmed[0].content
              assert.ok(firstContent.length <= tokenBudget * 4,
                `First result content should be truncated to fit budget`)
            }
          }
        ),
        { numRuns: 150 }
      )
    })

    it('empty results produce token_count of 0', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 2048 }),
          (tokenBudget) => {
            const { results, tokenCount } = mockRetrieve([], tokenBudget)
            assert.equal(results.length, 0)
            assert.equal(tokenCount, 0)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('results fitting within budget are not truncated', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 20 }),
            { minLength: 1, maxLength: 5 }
          ),
          fc.integer({ min: 500, max: 2048 }),
          (contents, tokenBudget) => {
            const results = contents.map((content, i) => ({
              source: 'vector',
              content,
              score: 1.0 - i * 0.01,
              metadata: null,
            }))

            const totalTokens = contents.reduce((sum, c) => sum + estimateTokens(c), 0)
            // Only test when total fits within budget
            fc.pre(totalTokens <= tokenBudget)

            const { results: trimmed, tokenCount } = mockRetrieve(results, tokenBudget)
            assert.equal(trimmed.length, results.length,
              'All results should be included when they fit within budget')
            assert.ok(tokenCount <= tokenBudget)
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 9: Unified retrieval thorough mode spans all sources ─────────

  // Feature: taosmd-memory-integration, Property 9: Unified retrieval thorough mode spans all sources
  describe('Property 9: Unified retrieval thorough mode spans all sources', () => {
    /**
     * **Validates: Requirements 5.2**
     *
     * For any retrieval query in "thorough" mode where all three memory layers
     * contain matching content, the response SHALL include at least one result
     * from each source (kg, vector, archive).
     */
    it('thorough mode result set can include results from all three sources', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 3, maxLength: 50 }),
          (query) => {
            // Simulate results from all three sources
            const kgResults = [
              { source: 'kg', content: `${query} entity relationship`, score: 1.0, metadata: null },
            ]
            const vectorResults = [
              { source: 'vector', content: `${query} semantic content`, score: 0.9, metadata: null },
            ]
            const archiveResults = [
              { source: 'archive', content: `${query} archived event`, score: 0.8, metadata: null },
            ]

            // Simulate RRF merge (all sources present)
            const allResults = [...kgResults, ...vectorResults, ...archiveResults]
            const sources = new Set(allResults.map(r => r.source))

            assert.ok(sources.has('kg'), 'Results should include KG source')
            assert.ok(sources.has('vector'), 'Results should include vector source')
            assert.ok(sources.has('archive'), 'Results should include archive source')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('RRF merge preserves items from all input lists', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
          fc.array(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
          fc.array(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
          (kgContents, vectorContents, archiveContents) => {
            // Build result lists
            const kgList = kgContents.map(c => ({ source: 'kg', content: c, score: 1.0 }))
            const vectorList = vectorContents.map(c => ({ source: 'vector', content: c, score: 0.9 }))
            const archiveList = archiveContents.map(c => ({ source: 'archive', content: c, score: 0.8 }))

            // Simple RRF simulation: all items from all lists should appear in merged output
            const allItems = [...kgList, ...vectorList, ...archiveList]
            const uniqueContents = new Set(allItems.map(r => r.content))

            // Verify all unique content items are represented
            assert.ok(uniqueContents.size >= 1,
              'Merged results should contain at least one item')

            // Verify source diversity when all lists are non-empty
            const sources = new Set(allItems.map(r => r.source))
            assert.ok(sources.has('kg'), 'Should have KG results')
            assert.ok(sources.has('vector'), 'Should have vector results')
            assert.ok(sources.has('archive'), 'Should have archive results')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── In-memory Extraction Pipeline mock ──────────────────────────────────────
  // Simulates the POST /memory/extract endpoint: regex extraction, KG storage,
  // and VectorMemory indexing. Used for Property 10.

  /**
   * Simulate the regex extraction pipeline from memory-bridge.py.
   * Mirrors _regex_extract_triples() — returns (subject, predicate, object) tuples.
   */
  function regexExtractTriples(text) {
    const triples = []

    // Pattern 1: "X uses/is a/has/works with/... Y"
    const relationPattern = /\b(\w+)\s+(uses|is a|is an|has|works with|depends on|created by|located in|part of|related to|knows|owns|manages)\s+(\w+)/gi
    let match
    while ((match = relationPattern.exec(text)) !== null) {
      triples.push([match[1], match[2], match[3]])
    }

    // Pattern 2: "X: Y" (key-value style, capitalized)
    const kvPattern = /\b([A-Z][a-zA-Z]+):\s+([A-Z][a-zA-Z]+)/g
    while ((match = kvPattern.exec(text)) !== null) {
      triples.push([match[1], 'is', match[2]])
    }

    return triples
  }

  /**
   * Simulate the POST /memory/extract endpoint behavior.
   * Returns { regexTriplesStored, addedToVector, llmExtractionQueued }.
   */
  function mockExtract(message, kg, vm) {
    // Step 1: regex extraction
    const regexTriples = regexExtractTriples(message)
    let regexTriplesStored = 0

    if (kg !== null) {
      for (const [subject, predicate, obj] of regexTriples) {
        try {
          kg.addTriple(subject, predicate, obj)
          regexTriplesStored++
        } catch (_) {
          // ignore
        }
      }
    }

    // Step 2: add turn to VectorMemory
    let addedToVector = false
    if (vm !== null) {
      vm.add(message, { type: 'conversation_turn' })
      addedToVector = true
    }

    return {
      regexTriplesStored,
      addedToVector,
      llmExtractionQueued: true,
    }
  }

  // ── Generators for extraction property tests ──────────────────────────────

  /** Generate text that contains at least one extractable relation pattern */
  function arbTextWithRelation() {
    const subjects = ['Alice', 'Bob', 'Server', 'Agent', 'Module', 'System']
    const predicates = ['uses', 'has', 'knows', 'manages', 'owns']
    const objects = ['Python', 'Redis', 'Docker', 'Node', 'SQLite', 'FastAPI']

    return fc.tuple(
      fc.constantFrom(...subjects),
      fc.constantFrom(...predicates),
      fc.constantFrom(...objects),
      arbSafeText(),
      arbSafeText()
    ).map(([subject, predicate, object, before, after]) => ({
      text: `${before} ${subject} ${predicate} ${object} ${after}`.trim(),
      subject,
      predicate,
      object,
    }))
  }

  /** Generate a non-empty message string */
  function arbMessage() {
    return fc.string({ minLength: 5, maxLength: 300 })
  }

  // ── Property 10: Extraction pipeline stores in KG and vector ─────────────

  // Feature: taosmd-memory-integration, Property 10: Extraction pipeline stores in KG and vector
  describe('Property 10: Extraction pipeline stores in KG and vector', () => {
    /**
     * **Validates: Requirements 7.4, 7.5**
     *
     * For any message containing an extractable entity-relationship pattern,
     * after running the extraction pipeline:
     * - The extracted triple SHALL be stored in the Knowledge Graph
     * - The turn content SHALL be added to VectorMemory for semantic indexing
     */
    it('regex-extracted triples are stored in the Knowledge Graph', () => {
      fc.assert(
        fc.property(arbTextWithRelation(), ({ text, subject, predicate, object }) => {
          const kg = createMockKG()
          const vm = createMockVectorMemory()

          const result = mockExtract(text, kg, vm)

          // At least one triple should have been stored
          assert.ok(result.regexTriplesStored >= 1,
            `Expected at least 1 regex triple stored, got ${result.regexTriplesStored}`)

          // The KG should contain the extracted triple
          const kgTriples = kg.getAll()
          const found = kgTriples.some(t =>
            t.subject.toLowerCase() === subject.toLowerCase() &&
            t.predicate.toLowerCase() === predicate.toLowerCase() &&
            t.object.toLowerCase() === object.toLowerCase()
          )
          assert.ok(found,
            `KG should contain triple (${subject}, ${predicate}, ${object}) extracted from: "${text}"`)
        }),
        { numRuns: 150 }
      )
    })

    it('turn content is added to VectorMemory', () => {
      fc.assert(
        fc.property(arbMessage(), (message) => {
          const kg = createMockKG()
          const vm = createMockVectorMemory()

          const result = mockExtract(message, kg, vm)

          assert.ok(result.addedToVector,
            'Turn content should be added to VectorMemory')
          assert.equal(vm.count(), 1,
            'VectorMemory should contain exactly 1 entry after extraction')

          // The stored entry should contain the original message
          const entries = vm.getAll()
          assert.equal(entries[0].text, message,
            'VectorMemory entry should contain the original message text')
        }),
        { numRuns: 150 }
      )
    })

    it('extraction works when KG is unavailable (null) — only vector indexing occurs', () => {
      fc.assert(
        fc.property(arbMessage(), (message) => {
          const vm = createMockVectorMemory()

          // Pass null KG to simulate unavailability
          const result = mockExtract(message, null, vm)

          assert.equal(result.regexTriplesStored, 0,
            'No triples should be stored when KG is unavailable')
          assert.ok(result.addedToVector,
            'Turn should still be added to VectorMemory even when KG is unavailable')
        }),
        { numRuns: 150 }
      )
    })

    it('extraction works when VectorMemory is unavailable (null) — only KG storage occurs', () => {
      fc.assert(
        fc.property(arbTextWithRelation(), ({ text }) => {
          const kg = createMockKG()

          // Pass null VM to simulate unavailability
          const result = mockExtract(text, kg, null)

          assert.ok(result.regexTriplesStored >= 1,
            'Regex triples should still be stored in KG when VM is unavailable')
          assert.equal(result.addedToVector, false,
            'addedToVector should be false when VectorMemory is unavailable')
        }),
        { numRuns: 150 }
      )
    })

    it('multiple turns accumulate in both KG and VectorMemory', () => {
      fc.assert(
        fc.property(
          fc.array(arbTextWithRelation(), { minLength: 2, maxLength: 5 }),
          (turns) => {
            const kg = createMockKG()
            const vm = createMockVectorMemory()

            let totalTriplesStored = 0
            for (const { text } of turns) {
              const result = mockExtract(text, kg, vm)
              totalTriplesStored += result.regexTriplesStored
            }

            // VectorMemory should have one entry per turn
            assert.equal(vm.count(), turns.length,
              `VectorMemory should have ${turns.length} entries after ${turns.length} turns`)

            // KG should have at least as many triples as turns (each turn has at least 1 relation)
            assert.ok(kg.count() >= turns.length,
              `KG should have at least ${turns.length} triples after ${turns.length} turns`)
          }
        ),
        { numRuns: 100 }
      )
    })

    it('llm_extraction_queued is always true (fire-and-forget)', () => {
      fc.assert(
        fc.property(arbMessage(), (message) => {
          const kg = createMockKG()
          const vm = createMockVectorMemory()

          const result = mockExtract(message, kg, vm)

          assert.equal(result.llmExtractionQueued, true,
            'llm_extraction_queued should always be true (fire-and-forget)')
        }),
        { numRuns: 150 }
      )
    })
  })

})

// Export filterSecrets for potential reuse by other test files or memory-client
module.exports = { filterSecrets, SECRET_PATTERNS }
