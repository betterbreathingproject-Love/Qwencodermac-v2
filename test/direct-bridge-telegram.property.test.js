'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const { EventEmitter } = require('node:events')
const { InputRequester } = require('../direct-bridge')

// Feature: telegram-video-recording, Property 10: Input request round-trip preserves reply text

describe('Property 10: Input request round-trip preserves reply text', () => {
  /**
   * For any question and reply string, `ask_user` delivers the exact reply
   * string to the agent.
   *
   * **Validates: Requirements 6.3**
   */
  it('ask() resolves with the exact reply text for any question/reply pair', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.integer(),
        async (question, reply, chatId) => {
          // Mock TelegramBot: EventEmitter that records sendMessage calls
          const bot = new EventEmitter()
          const sent = []
          bot.sendMessage = async (cid, text) => { sent.push({ cid, text }) }

          const requester = new InputRequester(bot, chatId)

          // Call ask (returns a Promise), then emit the reply after the
          // listener is registered (sendMessage is awaited first inside ask)
          const promise = requester.ask(question)
          // Allow the awaited sendMessage to resolve and the listener to attach
          await new Promise(r => setTimeout(r, 0))
          bot.emit('message', { chatId, text: reply })

          const result = await promise

          // The resolved value must be the exact reply string
          assert.equal(result, reply)
          // The question must have been sent via sendMessage
          assert.equal(sent.length, 1)
          assert.equal(sent[0].cid, chatId)
          assert.ok(sent[0].text.includes(question))
        }
      ),
      { numRuns: 150 }
    )
  })
})
