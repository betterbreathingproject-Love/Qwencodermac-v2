/**
 * Vision tool — SDK MCP server that gives the agent direct image analysis.
 *
 * The Qwen SDK CLI strips multimodal content from user messages, so images
 * cannot be passed through the normal prompt path.  This tool bypasses the
 * SDK entirely and calls the local MLX server's /v1/chat/completions endpoint
 * (the same path the Vision tab uses) with proper image_url content blocks.
 *
 * Usage from the agent:
 *   vision_analyze({ image_id: "img_0", prompt: "Describe this image" })
 *
 * Images are registered per-session via registerImages() before the query
 * starts, and the agent is told about them in the system prompt.
 */
const { tool, createSdkMcpServer } = require('@qwen-code/sdk')
const { z } = require('zod')
const http = require('http')

const SERVER_PORT = 8090

// ── per-session image store ───────────────────────────────────────────────────
// Module-level map so the tool closure and registerImages() always share the
// same reference — the SDK may wrap/proxy the server object returned by
// createSdkMcpServer, which can break instance-scoped closures.
let _images = new Map()

/**
 * Register images for the current agent session.
 * @param {Array<{name: string, b64: string}>} images - [{name, b64}] from renderer
 * @returns {string[]} list of image IDs the agent can reference
 */
function registerImages(images) {
  _images.clear()
  const ids = []
  for (let i = 0; i < images.length; i++) {
    const id = `img_${i}`
    _images.set(id, images[i].b64)
    ids.push(id)
  }
  return ids
}

/** Clear registered images (call on session end). */
function clearImages() {
  _images.clear()
}

/** Get the number of registered images. */
function getImageCount() {
  return _images.size
}

/** Get all registered image IDs. */
function getImageIds() {
  return Array.from(_images.keys())
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function chatCompletions(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: SERVER_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        timeout: 120000, // 2 min timeout for vision inference
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(data || 'Empty response from server'))
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Vision request timed out (120s). The model may be busy.'))
    })
    req.on('error', (err) =>
      reject(new Error(`Vision server not reachable: ${err.message}`))
    )
    req.write(body)
    req.end()
  })
}

// ── tool definitions ──────────────────────────────────────────────────────────

const visionAnalyzeTool = tool(
  'vision_analyze',
  `Analyze an image using the vision model. Use this tool whenever you need to see, describe, or reason about an image the user has attached. You can reference images by their ID (e.g. "img_0", "img_1"). Provide a prompt describing what you want to know about the image.`,
  {
    image_id: z
      .string()
      .describe(
        'The ID of the image to analyze (e.g. "img_0"). Use "all" to analyze all attached images together.'
      ),
    prompt: z
      .string()
      .describe(
        'What to analyze or ask about the image. Be specific for better results.'
      ),
  },
  async ({ image_id, prompt }) => {
    // Resolve which images to include
    let imageUrls = []
    if (image_id === 'all') {
      imageUrls = Array.from(_images.values())
    } else {
      const b64 = _images.get(image_id)
      if (!b64) {
        const available = Array.from(_images.keys()).join(', ') || 'none'
        return {
          content: [
            {
              type: 'text',
              text: `Error: image "${image_id}" not found. Available images: ${available}`,
            },
          ],
          isError: true,
        }
      }
      imageUrls = [b64]
    }

    // Build multimodal content array — same format the Vision tab uses
    const content = [{ type: 'text', text: prompt }]
    for (const url of imageUrls) {
      content.push({ type: 'image_url', image_url: { url } })
    }

    // Try with retry — server may restart after a crash
    const MAX_RETRIES = 2
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await chatCompletions({
          messages: [{ role: 'user', content }],
          max_tokens: 1024,
        })

        if (result.error) {
          return {
            content: [{ type: 'text', text: `Vision error: ${result.error}` }],
            isError: true,
          }
        }

        const text =
          result.choices?.[0]?.message?.content || JSON.stringify(result)
        let response = text

        if (result.usage) {
          const u = result.usage
          response += `\n\n[Vision stats: ${u.prompt_tokens} prompt tokens, ${u.completion_tokens || u.generation_tokens || 0} gen tokens]`
        }

        return { content: [{ type: 'text', text: response }] }
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          // Wait for server to restart
          await new Promise((r) => setTimeout(r, 4000))
          continue
        }
        return {
          content: [
            { type: 'text', text: `Vision tool error after ${MAX_RETRIES + 1} attempts: ${err.message}` },
          ],
          isError: true,
        }
      }
    }
  }
)

// ── standalone analyze function (for DirectBridge) ────────────────────────────

/**
 * Analyze image(s) by calling the local MLX vision endpoint directly.
 * @param {string} imageId - "img_0", "img_1", or "all"
 * @param {string} prompt - What to ask about the image
 * @returns {{ text: string, isError: boolean }}
 */
async function analyzeImage(imageId, prompt) {
  let imageUrls = []
  if (imageId === 'all') {
    imageUrls = Array.from(_images.values())
  } else {
    const b64 = _images.get(imageId)
    if (!b64) {
      const available = Array.from(_images.keys()).join(', ') || 'none'
      return { text: `Image "${imageId}" not found. Available images: ${available}`, isError: true }
    }
    imageUrls = [b64]
  }

  const content = [{ type: 'text', text: prompt }]
  for (const url of imageUrls) {
    content.push({ type: 'image_url', image_url: { url } })
  }

  const MAX_RETRIES = 2
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await chatCompletions({
        messages: [{ role: 'user', content }],
        max_tokens: 1024,
      })
      if (result.error) {
        return { text: `Vision error: ${result.error}`, isError: true }
      }
      const text = result.choices?.[0]?.message?.content || JSON.stringify(result)
      let response = text
      if (result.usage) {
        const u = result.usage
        response += `\n\n[Vision stats: ${u.prompt_tokens} prompt tokens, ${u.completion_tokens || u.generation_tokens || 0} gen tokens]`
      }
      return { text: response, isError: false }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      return { text: `Vision tool error after ${MAX_RETRIES + 1} attempts: ${err.message}`, isError: true }
    }
  }
}

// ── create the MCP server ─────────────────────────────────────────────────────

function createVisionServer() {
  return createSdkMcpServer({
    name: 'vision',
    version: '1.0.0',
    tools: [visionAnalyzeTool],
  })
}

module.exports = {
  createVisionServer,
  registerImages,
  clearImages,
  getImageCount,
  getImageIds,
  analyzeImage,
}
