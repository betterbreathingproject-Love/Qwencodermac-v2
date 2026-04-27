"""
MLX Vision Server — OpenAI-compatible API with vision + tool calling support.
Serves at http://localhost:8090/v1
"""

import os, base64, tempfile, time, uuid, json, asyncio, re, sys, threading
from pathlib import Path
from typing import Optional, Union, Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── model state ───────────────────────────────────────────────────────────────
_model = None
_processor = None
_config = None
_model_id = None
_model_path = None
_chat_template = None
_model_is_vision = True  # False when loaded via mlx_lm (text-only fallback)
_models_root = Path.home() / ".lmstudio" / "models"

# ── inference queue ───────────────────────────────────────────────────────────
# Instead of a single threading.Lock that blocks all callers, we use an
# asyncio.Queue(maxsize=1) as a semaphore. This lets FastAPI's event loop
# stay responsive while requests wait their turn, and enables fair FIFO
# ordering with a configurable queue depth.
_INFERENCE_QUEUE_SIZE = int(os.environ.get("MLX_QUEUE_SIZE", "4"))
_inference_semaphore: asyncio.Semaphore | None = None  # initialized at startup


def _get_inference_semaphore() -> asyncio.Semaphore:
    """Lazy-init the semaphore on the running event loop."""
    global _inference_semaphore
    if _inference_semaphore is None:
        # MLX is single-threaded on Metal, so concurrency=1 serializes inference
        # but the semaphore lets waiters queue without blocking the event loop.
        _inference_semaphore = asyncio.Semaphore(1)
    return _inference_semaphore


def find_models():
    models = []
    for cfg_path in sorted(_models_root.rglob("config.json")):
        rel = cfg_path.parent.relative_to(_models_root)
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
            model_type = cfg.get("model_type", "unknown")
            has_vision = "vision_config" in cfg or "image_token_id" in cfg

            # Check if vision weights actually exist in safetensors
            # (distilled text-only models may inherit vision config fields
            # from the base architecture without shipping the weights)
            if has_vision:
                idx_path = cfg_path.parent / "model.safetensors.index.json"
                if idx_path.exists():
                    try:
                        with open(idx_path) as f:
                            idx = json.load(f)
                        weight_keys = idx.get("weight_map", {}).keys()
                        has_vision = any("vision" in k for k in weight_keys)
                    except Exception:
                        pass

            models.append({
                "id": str(rel),
                "path": str(cfg_path.parent),
                "model_type": model_type,
                "vision": has_vision,
            })
        except Exception:
            pass
    return models


def _unload_model():
    """Release the current model and free Metal memory before loading a new one."""
    global _model, _processor, _config, _model_id, _model_path, _chat_template, _model_is_vision
    if _model is not None:
        print(f"[server] Unloading current model: {_model_id}")
        _model = None
        _processor = None
        _config = None
        _model_id = None
        _model_path = None
        _chat_template = None
        _model_is_vision = True
        import gc
        gc.collect()
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass
        print(f"[server] Model unloaded, Metal cache cleared")


def load_model(model_path: str):
    global _model, _processor, _config, _model_id, _model_path, _chat_template, _model_is_vision
    print(f"[server] Loading {model_path} ...")

    # Try mlx_vlm first (vision-capable), fall back to mlx_lm (text-only)
    # if the model is missing vision tower weights (e.g. distilled text-only
    # models that inherit vision config fields from the base architecture).
    try:
        from mlx_vlm import load
        from mlx_vlm.utils import load_config
        _model, _processor = load(model_path)
        _config = load_config(model_path)
        _model_is_vision = True
        print(f"[server] Loaded as vision model (mlx_vlm)")
    except ValueError as e:
        if "Missing" in str(e) and "vision_tower" in str(e):
            print(f"[server] Vision weights missing — falling back to text-only (mlx_lm)")
            from mlx_lm import load as lm_load
            _model, _processor = lm_load(model_path)
            _config = None
            _model_is_vision = False
            print(f"[server] Loaded as text-only model (mlx_lm)")
        else:
            raise

    _model_path = model_path

    raw_id = str(Path(model_path).relative_to(_models_root))

    # The Qwen SDK uses model ID regex to determine modality support.
    # It recognizes "qwen3-vl-*" as vision-capable. All models on this
    # server are Qwen vision models, so always alias to qwen3-vl-*.
    _model_id = f"qwen3-vl-{raw_id.replace('/', '-')}"
    print(f"[server] Reporting model as: {_model_id}")

    # load Jinja chat template for tool calling support
    _chat_template = None
    # Check for enhanced template first (preferred), then standard name
    jinja_path = Path(model_path) / "qwen3.5-enhanced.jinja"
    if not jinja_path.exists():
        jinja_path = Path(model_path) / "chat_template.jinja"
    if jinja_path.exists():
        _chat_template = jinja_path.read_text()
        print(f"[server] Loaded {jinja_path.name} (tool calling enabled)")
        # Log the tool call format the template instructs
        if '<tool_call>' in _chat_template:
            if '<function=' in _chat_template:
                print(f"[server] Template format: XML-parameter style (<function=name><parameter=key>value</parameter>)", file=sys.stderr)
            elif '"name"' in _chat_template or "'name'" in _chat_template:
                print(f"[server] Template format: JSON style ({{\"name\": ..., \"arguments\": ...}})", file=sys.stderr)
            else:
                print(f"[server] Template format: unknown tool_call style", file=sys.stderr)
        print(f"[server] Template length: {len(_chat_template)} chars", file=sys.stderr)
    else:
        # try tokenizer_config.json
        tok_cfg_path = Path(model_path) / "tokenizer_config.json"
        if tok_cfg_path.exists():
            with open(tok_cfg_path) as f:
                tok_cfg = json.load(f)
            if tok_cfg.get("chat_template"):
                _chat_template = tok_cfg["chat_template"]
                print(f"[server] Loaded chat_template from tokenizer_config.json")
    if not _chat_template:
        print(f"[server] WARNING: No chat template found — tool calling will not work")
    print(f"[server] Ready: {_model_id}")


# ── app ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="MLX Vision Server")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ── schemas ───────────────────────────────────────────────────────────────────
class Message(BaseModel):
    role: str
    content: Optional[Union[str, list]] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


class ToolFunction(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[dict] = None


class Tool(BaseModel):
    type: str = "function"
    function: ToolFunction


class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: list[Message]
    max_tokens: Optional[int] = 8192
    temperature: Optional[float] = 0.6
    top_p: Optional[float] = 0.95
    repetition_penalty: Optional[float] = 1.05
    stream: Optional[bool] = False
    tools: Optional[list[Tool]] = None
    tool_choice: Optional[Any] = None


class LoadRequest(BaseModel):
    model_path: str


# ── tool call parsing ─────────────────────────────────────────────────────────
_TOOL_CALL_RE = re.compile(
    r'<tool_call>\s*<function=([^>]+)>(.*?)</function>\s*</tool_call>',
    re.DOTALL
)
# Fallback: <tool_call> blocks containing JSON (Qwen 2.5/3.x alternate format)
# Use greedy match to capture the full JSON including nested braces
_TOOL_CALL_JSON_RE = re.compile(
    r'<tool_call>\s*(\{.+\})\s*</tool_call>',
    re.DOTALL
)
_PARAM_RE = re.compile(
    r'<parameter=([^>]+)>\n?(.*?)\n?</parameter>',
    re.DOTALL
)


def parse_tool_calls(text: str):
    """Parse Qwen-format <tool_call> blocks into OpenAI tool_calls format.
    Supports both XML-parameter style and JSON style tool calls."""
    tool_calls = []
    for match in _TOOL_CALL_RE.finditer(text):
        func_name = match.group(1).strip()
        body = match.group(2)
        args = {}
        for pm in _PARAM_RE.finditer(body):
            param_name = pm.group(1).strip()
            param_value = pm.group(2).strip()
            # try to parse as JSON value, fall back to string
            try:
                args[param_name] = json.loads(param_value)
            except (json.JSONDecodeError, ValueError):
                args[param_name] = param_value
        tool_calls.append({
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": func_name,
                "arguments": json.dumps(args),
            }
        })

    # Fallback: if no XML-style tool calls found, try JSON-style
    # e.g. <tool_call>{"name": "read_file", "arguments": {"path": "index.html"}}</tool_call>
    if not tool_calls:
        for match in _TOOL_CALL_JSON_RE.finditer(text):
            try:
                obj = json.loads(match.group(1))
                name = obj.get("name", "")
                arguments = obj.get("arguments", {})
                if name:
                    tool_calls.append({
                        "id": f"call_{uuid.uuid4().hex[:12]}",
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
                        }
                    })
            except (json.JSONDecodeError, ValueError):
                pass

    return tool_calls


# ── incremental tool call parsing for streaming ──────────────────────────────
_FUNC_NAME_RE = re.compile(r'<function=([^>]+)>')

def parse_partial_tool_args(body: str) -> str:
    """Parse completed <parameter> tags from a partial tool call body into JSON.
    Returns the JSON-encoded arguments string built so far."""
    args = {}
    for pm in _PARAM_RE.finditer(body):
        param_name = pm.group(1).strip()
        param_value = pm.group(2).strip()
        try:
            args[param_name] = json.loads(param_value)
        except (json.JSONDecodeError, ValueError):
            args[param_name] = param_value

    # Also capture a parameter that's still being written (no closing tag yet)
    # e.g. <parameter=content>partial code here...
    last_open = body.rfind('<parameter=')
    if last_open != -1:
        after = body[last_open:]
        # Check if this parameter is NOT closed yet
        close_pos = after.find('</parameter>')
        if close_pos == -1:
            # Extract name and partial value
            name_match = re.match(r'<parameter=([^>]+)>\n?', after)
            if name_match:
                param_name = name_match.group(1).strip()
                partial_val = after[name_match.end():]
                if param_name not in args:
                    args[param_name] = partial_val

    return json.dumps(args)


def strip_tool_calls(text: str) -> str:
    """Remove <tool_call> blocks from text to get the content portion."""
    cleaned = _TOOL_CALL_RE.sub('', text).strip()
    return cleaned


def strip_thinking(text: str) -> str:
    """Remove <think>...</think> blocks from text."""
    return re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()


# ── helpers ───────────────────────────────────────────────────────────────────
def extract_text_and_images(messages: list[Message]):
    """Return (last_user_text, [image_paths]) from a message list."""
    images, text = [], ""
    for msg in messages:
        if msg.role != "user":
            continue
        if isinstance(msg.content, str):
            text = msg.content
        elif isinstance(msg.content, list):
            parts_text = []
            for part in msg.content:
                p = part if isinstance(part, dict) else part.dict()
                if p.get("type") == "text":
                    parts_text.append(p.get("text", ""))
                elif p.get("type") == "image_url":
                    url = (p.get("image_url") or {}).get("url", "")
                    if url.startswith("data:image"):
                        header, b64 = url.split(",", 1)
                        ext = header.split("/")[1].split(";")[0]
                        img_bytes = base64.b64decode(b64)
                        # Resize large images to prevent MLX OOM
                        img_bytes = _resize_image(img_bytes, max_dim=768)
                        tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
                        tmp.write(img_bytes)
                        tmp.flush()
                        tmp.close()
                        images.append(tmp.name)
                    elif url:
                        images.append(url)
            text = " ".join(parts_text)
    return text, images


def _resize_image(img_bytes: bytes, max_dim: int = 768) -> bytes:
    """Resize image if either dimension exceeds max_dim. Returns raw bytes."""
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_bytes))
        w, h = img.size
        if w <= max_dim and h <= max_dim:
            return img_bytes
        # Scale down preserving aspect ratio
        scale = max_dim / max(w, h)
        new_w, new_h = int(w * scale), int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        fmt = img.format or "PNG"
        if fmt.upper() == "JPEG" or img.mode == "RGB":
            img.save(buf, format="JPEG", quality=85)
        else:
            if img.mode == "RGBA":
                img.save(buf, format="PNG")
            else:
                img.save(buf, format="PNG")
        print(f"[server] Resized image {w}x{h} → {new_w}x{new_h}", file=sys.stderr)
        return buf.getvalue()
    except ImportError:
        print("[server] PIL not available, skipping image resize", file=sys.stderr)
        return img_bytes
    except Exception as e:
        print(f"[server] Image resize failed: {e}", file=sys.stderr)
        return img_bytes


def get_system_prompt(messages):
    for msg in messages:
        if msg.role == "system":
            return msg.content if isinstance(msg.content, str) else ""
    return None


def _cleanup_images(images):
    for img in images:
        if img.startswith(tempfile.gettempdir()):
            try: os.unlink(img)
            except: pass


# ── prompt building ───────────────────────────────────────────────────────────
def _build_prompt_with_tools(req: ChatRequest):
    """Build prompt using the Jinja chat template directly, with tools support."""
    from jinja2 import Environment, BaseLoader

    # convert messages to template format
    tmpl_messages = []
    for msg in req.messages:
        m = {"role": msg.role}
        if msg.content is not None:
            if isinstance(msg.content, list):
                # flatten multimodal content to text for tool-calling path
                parts = []
                for p in msg.content:
                    pp = p if isinstance(p, dict) else p.dict()
                    if pp.get("type") == "text":
                        parts.append(pp["text"])
                m["content"] = " ".join(parts)
            else:
                m["content"] = msg.content
        else:
            m["content"] = ""
        if msg.tool_calls:
            # Ensure tool_call arguments are dicts (not JSON strings) so the
            # Jinja template's `arguments is mapping` check works correctly.
            # The template iterates over arguments as key-value pairs.
            fixed_tool_calls = []
            for tc in msg.tool_calls:
                tc_copy = dict(tc) if isinstance(tc, dict) else tc
                if isinstance(tc_copy, dict):
                    fn = tc_copy.get("function", {})
                    if isinstance(fn, dict) and isinstance(fn.get("arguments"), str):
                        try:
                            fn["arguments"] = json.loads(fn["arguments"])
                        except (json.JSONDecodeError, ValueError):
                            pass
                fixed_tool_calls.append(tc_copy)
            m["tool_calls"] = fixed_tool_calls
        if msg.tool_call_id:
            # tool result message — Qwen template expects role="tool"
            m["role"] = "tool"
        tmpl_messages.append(m)

    # convert tools to template format
    tmpl_tools = None
    if req.tools:
        tmpl_tools = []
        for t in req.tools:
            tmpl_tools.append({
                "type": "function",
                "function": {
                    "name": t.function.name,
                    "description": t.function.description or "",
                    "parameters": t.function.parameters or {},
                }
            })

    env = Environment(loader=BaseLoader(), keep_trailing_newline=True)
    env.globals["raise_exception"] = lambda msg: (_ for _ in ()).throw(Exception(msg))
    template = env.from_string(_chat_template)

    # Template kwargs — the enhanced Barubary template supports these:
    # - auto_disable_thinking_with_tools: prevents <tool_call> leaking into <think> blocks
    # - max_tool_response_chars: truncate large tool responses in history
    template_kwargs = {
        "messages": tmpl_messages,
        "tools": tmpl_tools,
        "add_generation_prompt": True,
        "enable_thinking": True,
        "auto_disable_thinking_with_tools": True,
        "max_tool_response_chars": 8000,
    }

    try:
        prompt = template.render(**template_kwargs)
    except Exception as e:
        print(f"[server] ❌ Jinja template render FAILED: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        # Fallback: render without tools
        prompt = template.render(
            messages=tmpl_messages,
            tools=None,
            add_generation_prompt=True,
            enable_thinking=True,
        )

    # Debug: log whether tools appear in the rendered prompt
    if tmpl_tools:
        tool_names_in_prompt = [t["function"]["name"] for t in tmpl_tools if t["function"]["name"] in prompt]
        if not tool_names_in_prompt:
            print(f"[server] ⚠️ WARNING: No tool names found in rendered prompt! Template may not be rendering tools.", file=sys.stderr)
            print(f"[server] Prompt first 500 chars: {prompt[:500]}", file=sys.stderr)
        else:
            print(f"[server] ✅ Tools in prompt: {tool_names_in_prompt[:5]}...", file=sys.stderr)

    return prompt


def _build_prompt_and_kwargs(req: ChatRequest):
    """Build prompt — uses Jinja template when tools present, mlx_vlm otherwise."""
    images = []
    if _model_is_vision:
        _, images = extract_text_and_images(req.messages)

    has_tools = bool(req.tools) and bool(_chat_template)

    if has_tools:
        prompt = _build_prompt_with_tools(req)
        print(f"[server] Built prompt with tools ({len(req.tools)} tools), len={len(prompt)}", file=sys.stderr)
    elif _model_is_vision:
        from mlx_vlm.prompt_utils import apply_chat_template
        text, _ = extract_text_and_images(req.messages)
        system = get_system_prompt(req.messages)
        prompt = apply_chat_template(
            _processor, _config, text,
            num_images=len(images),
            system_prompt=system,
        )
    else:
        # Text-only model (mlx_lm) — build prompt via chat template or manual concat
        if _chat_template:
            prompt = _build_prompt_with_tools(req)
        else:
            # Simple fallback: concatenate messages
            parts = []
            for msg in req.messages:
                content = msg.content if isinstance(msg.content, str) else str(msg.content or "")
                parts.append(f"<|im_start|>{msg.role}\n{content}<|im_end|>")
            parts.append("<|im_start|>assistant\n")
            prompt = "\n".join(parts)
        print(f"[server] Built text-only prompt, len={len(prompt)}", file=sys.stderr)

    kwargs = dict(max_tokens=min(req.max_tokens or 1024, 16384))
    if _model_is_vision:
        kwargs["verbose"] = False
    if req.temperature is not None:
        if _model_is_vision:
            kwargs["temp"] = req.temperature
        else:
            # mlx_lm uses a sampler callable for temperature control
            import mlx.core as mx
            t = req.temperature
            if t == 0:
                kwargs["sampler"] = lambda logits: mx.argmax(logits, axis=-1)
            else:
                def _temp_sampler(logits, _t=t):
                    return mx.random.categorical(logits / _t)
                kwargs["sampler"] = _temp_sampler
    if req.top_p is not None:
        if _model_is_vision:
            kwargs["top_p"] = req.top_p
    if req.repetition_penalty is not None:
        if _model_is_vision:
            kwargs["repetition_penalty"] = req.repetition_penalty
    if images:
        kwargs["image"] = images[0] if len(images) == 1 else images
    return prompt, kwargs, images


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": f"qwen3-vl-{m['id'].replace('/', '-')}",
                "path": m["path"],
                "object": "model",
                "owned_by": "mlx",
                "model_type": m["model_type"],
                "vision": m["vision"],
                "capabilities": (["tool_use", "image_input"] if m["vision"]
                                 else ["tool_use"]),
                "architecture": {
                    "input_modalities": (["text", "image"] if m["vision"]
                                         else ["text"]),
                    "output_modalities": ["text"],
                },
            }
            for m in find_models()
        ],
    }


@app.post("/admin/load")
async def admin_load(req: LoadRequest):
    # Acquire the inference semaphore so we don't swap the model while an
    # inference request is in-flight.  This waits (without blocking the
    # event loop) until any running inference finishes.
    sem = _get_inference_semaphore()
    async with sem:
        try:
            # Free the old model *before* loading the new one so both don't
            # coexist in Metal memory (which causes OOM crashes).
            _unload_model()
            # load_model is CPU/IO-heavy — run in a thread so the event loop
            # stays responsive and the server doesn't appear to crash.
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, load_model, req.model_path)
            return {"status": "ok", "model_id": _model_id}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))


@app.get("/admin/status")
def admin_status():
    models = find_models()
    # alias all model IDs to qwen3-vl-* for SDK vision support
    for m in models:
        m["id"] = f"qwen3-vl-{m['id'].replace('/', '-')}"
    return {"loaded": _model_id, "models": models}


# ── benchmark ─────────────────────────────────────────────────────────────────
BENCHMARK_PROMPT = (
    "You are a helpful coding assistant. Explain step by step how to implement "
    "a binary search algorithm in Python. Include the function signature, the "
    "base case for an empty array, the midpoint calculation using integer "
    "division, the comparison logic for the target value against the middle "
    "element, and the recursive calls for the left and right halves of the "
    "array. Also describe the time complexity and space complexity of the "
    "algorithm, and give an example of calling the function with a sorted "
    "list of integers and a target value that exists in the list."
)


class BenchmarkResponse(BaseModel):
    generation_tps: float
    prompt_tps: float
    peak_memory_gb: float
    available_memory_gb: float
    context_window: int


@app.post("/admin/benchmark")
async def benchmark():
    """Run a short inference pass and return performance metrics."""
    if _model is None:
        raise HTTPException(status_code=503, detail="No model loaded")

    sem = _get_inference_semaphore()
    async with sem:
        try:
            import mlx.core as mx

            # Build a simple text prompt for benchmarking
            if _model_is_vision:
                from mlx_vlm import generate
                from mlx_vlm.prompt_utils import apply_chat_template
                prompt = apply_chat_template(
                    _processor, _config, BENCHMARK_PROMPT,
                    num_images=0,
                )
                gen_kwargs = dict(max_tokens=80, verbose=False)
            else:
                from mlx_lm import generate
                # Build prompt using chat template or simple fallback
                if _chat_template:
                    from jinja2 import Environment, BaseLoader
                    env = Environment(loader=BaseLoader(), keep_trailing_newline=True)
                    env.globals["raise_exception"] = lambda msg: (_ for _ in ()).throw(Exception(msg))
                    template = env.from_string(_chat_template)
                    prompt = template.render(
                        messages=[{"role": "user", "content": BENCHMARK_PROMPT}],
                        tools=None,
                        add_generation_prompt=True,
                        enable_thinking=False,
                    )
                else:
                    prompt = f"<|im_start|>user\n{BENCHMARK_PROMPT}<|im_end|>\n<|im_start|>assistant\n"
                gen_kwargs = dict(max_tokens=80)

            # Run generation in a thread to keep the event loop responsive
            loop = asyncio.get_event_loop()

            start = time.perf_counter()
            result = await loop.run_in_executor(
                None, lambda: generate(_model, _processor, prompt, **gen_kwargs)
            )
            elapsed = time.perf_counter() - start

            # Prefer MLX's own TPS metrics — they measure each phase separately
            # and match what users see during normal inference.
            gen_tps = getattr(result, 'generation_tps', None)
            prompt_tps = getattr(result, 'prompt_tps', None)

            # Fallback: estimate from token counts / total elapsed (less accurate)
            if gen_tps is None or prompt_tps is None:
                gen_tokens = getattr(result, 'generation_tokens', None)
                prompt_tokens = getattr(result, 'prompt_tokens', None)
                if gen_tokens is None:
                    result_text = result.text if hasattr(result, 'text') else str(result)
                    gen_tokens = max(1, len(result_text.split()))
                if prompt_tokens is None:
                    prompt_tokens = max(1, len(BENCHMARK_PROMPT.split()))
                if gen_tps is None:
                    gen_tps = gen_tokens / elapsed if elapsed > 0 else 0
                if prompt_tps is None:
                    prompt_tps = prompt_tokens / elapsed if elapsed > 0 else 0

            peak_mem = mx.metal.get_peak_memory() / (1024**3)
            # Available memory = total system memory minus what MLX is actively using
            import os
            total_mem = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / (1024**3)
            active_mem = mx.metal.get_active_memory() / (1024**3)
            avail_mem = max(0, total_mem - active_mem)

            # Read context window from model config
            ctx_window = 32768  # default
            if _config and isinstance(_config, dict):
                ctx_window = _config.get("max_position_embeddings", 32768)
            elif _model_path:
                # Text-only model: read from config.json on disk
                try:
                    cfg_path = Path(_model_path) / "config.json"
                    if cfg_path.exists():
                        with open(cfg_path) as f:
                            disk_cfg = json.load(f)
                        ctx_window = disk_cfg.get("max_position_embeddings", 32768)
                except Exception:
                    pass

            return BenchmarkResponse(
                generation_tps=round(gen_tps, 2),
                prompt_tps=round(prompt_tps, 2),
                peak_memory_gb=round(peak_mem, 3),
                available_memory_gb=round(avail_mem, 3),
                context_window=ctx_window,
            )
        except Exception as e:
            # Task 3.2: Metal memory error handling
            if "metal" in str(e).lower() or "mps" in str(e).lower():
                try:
                    import mlx.core as mx
                    mx.metal.clear_cache()
                    import gc
                    gc.collect()
                except Exception:
                    pass
                raise HTTPException(status_code=500, detail=f"Metal memory error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    if _model is None:
        raise HTTPException(503, "No model loaded.")

    has_tools = bool(req.tools)
    _, images_check = extract_text_and_images(req.messages)
    has_images = bool(images_check)
    # clean up the check images (they'll be re-extracted in _build_prompt_and_kwargs)
    _cleanup_images(images_check)

    # Clear MLX cache before every request to free memory and prevent OOM crashes
    try:
        import mlx.core as mx
        import gc
        gc.collect()
        mx.metal.clear_cache()
    except Exception:
        pass

    # Preventive guard: check Metal memory before inference
    try:
        import mlx.core as mx
        mem_active = mx.metal.get_active_memory() / (1024**3)
        # Use 80% of system memory as threshold (Apple Silicon shares RAM with GPU)
        import subprocess
        total_mem_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).strip())
        total_mem_gb = total_mem_bytes / (1024**3)
        threshold_gb = total_mem_gb * 0.80
        if mem_active > threshold_gb:
            print(f"[server] ⚠️ Metal memory too high: {mem_active:.2f} GB / {total_mem_gb:.1f} GB (threshold: {threshold_gb:.1f} GB)", file=sys.stderr)
            mx.metal.clear_cache()
            import gc
            gc.collect()
            # Re-check after clearing
            mem_after = mx.metal.get_active_memory() / (1024**3)
            if mem_after > threshold_gb:
                raise HTTPException(503, f"Server busy — Metal memory too high ({mem_after:.1f}/{total_mem_gb:.1f} GB). Retry after a moment.")
    except HTTPException:
        raise
    except Exception:
        pass  # If memory check fails, proceed anyway

    # Preventive guard: reject dangerously large prompts
    # Use the model's actual context window (with 10% safety margin) instead of hardcoded 30k
    ctx_window = 32768  # default
    if _config and isinstance(_config, dict):
        ctx_window = _config.get("max_position_embeddings", 32768)
    elif _model_path:
        try:
            cfg_path = Path(_model_path) / "config.json"
            if cfg_path.exists():
                with open(cfg_path) as f:
                    disk_cfg = json.load(f)
                ctx_window = disk_cfg.get("max_position_embeddings", 32768)
        except Exception:
            pass
    prompt_limit = int(ctx_window * 0.9)  # 90% of context window

    total_chars = sum(len(str(msg.content or '')) for msg in req.messages)
    # For vision messages with images, base64 data inflates char count massively
    # but MLX VLM processes images as ~1000-2000 tokens regardless of base64 size.
    # Subtract base64 image data from the char count and add a flat token estimate.
    image_chars = 0
    image_count = 0
    for msg in req.messages:
        if isinstance(msg.content, list):
            for part in msg.content:
                if isinstance(part, dict) and part.get('type') == 'image_url':
                    url = part.get('image_url', {}).get('url', '')
                    if url.startswith('data:'):
                        image_chars += len(url)
                        image_count += 1
    # Each image is ~1500 tokens in MLX VLM, not len(base64)/4
    adjusted_chars = total_chars - image_chars
    estimated_tokens = max(0, adjusted_chars // 4) + (image_count * 1500)

    if estimated_tokens > prompt_limit:
        print(f"[server] ⚠️ Prompt too large: ~{estimated_tokens} estimated tokens ({total_chars} chars, limit={prompt_limit})", file=sys.stderr)
        raise HTTPException(413, json.dumps({
            "error": "Prompt too large",
            "estimated_tokens": estimated_tokens,
            "limit": prompt_limit,
        }))

    # debug logging
    for msg in req.messages:
        if isinstance(msg.content, list):
            types = [p.get("type") if isinstance(p, dict) else "?" for p in msg.content]
            print(f"[server] msg role={msg.role} content_parts={types}", file=sys.stderr)
        else:
            clen = len(str(msg.content)) if msg.content else 0
            print(f"[server] msg role={msg.role} content=str({clen} chars)", file=sys.stderr)
    if has_tools:
        tool_names = [t.function.name for t in req.tools]
        print(f"[server] tools={tool_names}", file=sys.stderr)

    # ── streaming ─────────────────────────────────────────────────────────────
    if req.stream:
        if _model_is_vision:
            from mlx_vlm import stream_generate
        else:
            from mlx_lm import stream_generate

        prompt, kwargs, images = _build_prompt_and_kwargs(req)
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        print(f"[server] Streaming: prompt_len={len(prompt)}, temp={kwargs.get('temp', 'default')}, top_p={kwargs.get('top_p', 'default')}", file=sys.stderr)

        # Clear cache before large prompts to maximize available memory
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass

        async def event_stream():
            sem = _get_inference_semaphore()
            loop = asyncio.get_event_loop()
            queue: asyncio.Queue = asyncio.Queue()
            full_text_parts = []

            def run_stream():
                try:
                    gen = stream_generate(_model, _processor, prompt, **kwargs)
                    last_result = None
                    for chunk in gen:
                        text = chunk.text if hasattr(chunk, 'text') else str(chunk)
                        if text:
                            loop.call_soon_threadsafe(queue.put_nowait, ("token", text))
                        last_result = chunk
                    if last_result and hasattr(last_result, 'prompt_tps'):
                        loop.call_soon_threadsafe(queue.put_nowait, ("stats", last_result))
                except Exception as e:
                    import traceback
                    print(f"[server] ❌ Stream inference error ({type(e).__name__}): {e}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                    try:
                        import mlx.core as mx
                        mem_active = mx.metal.get_active_memory() / (1024**3)
                        mem_peak = mx.metal.get_peak_memory() / (1024**3)
                        print(f"[server] Metal memory — active: {mem_active:.2f} GB, peak: {mem_peak:.2f} GB", file=sys.stderr)
                    except Exception:
                        pass
                    loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)))
                finally:
                    try:
                        import mlx.core as mx
                        mx.metal.clear_cache()
                    except Exception:
                        pass
                    loop.call_soon_threadsafe(queue.put_nowait, ("done", None))

            # Acquire the semaphore asynchronously — other requests wait here
            # without blocking the event loop.
            async with sem:
                loop.run_in_executor(None, run_stream)

                accumulated = ""
                _content_sent_len = 0       # how much of accumulated we've sent as content
                # ── incremental tool call streaming state ─────────────────
                _in_tool_call = False       # True once we see <tool_call>
                _tool_call_buf = ""         # raw text inside the tool call block
                _tc_index = 0               # tool call index counter
                _tc_id = ""                 # current tool call id
                _tc_func_name = ""          # function name once detected
                _tc_name_sent = False       # whether we've sent the name delta
                _tc_last_args_len = 0       # track how much of args we've sent
                _tc_json_args = None        # JSON-style args (when model uses JSON instead of XML params)
                _tc_completed = []          # list of completed tool call chunks
                _TOOL_OPEN = "<tool_call>"
                _TOOL_CLOSE = "</tool_call>"
                _PARTIAL_TAGS = ("<", "<t", "<to", "<too", "<tool",
                                 "<tool_", "<tool_c", "<tool_ca",
                                 "<tool_cal", "<tool_call")

                while True:
                    kind, data = await queue.get()
                    if kind == "token":
                        accumulated += data
                        full_text_parts.append(data)

                        # ── detect tool call boundaries ───────────────────
                        if not _in_tool_call:
                            # Check if we've entered a tool call block
                            tc_start = accumulated.find(_TOOL_OPEN, _content_sent_len)
                            if tc_start != -1:
                                _in_tool_call = True
                                _tc_id = f"call_{uuid.uuid4().hex[:12]}"
                                _tc_func_name = ""
                                _tc_name_sent = False
                                _tc_last_args_len = 0
                                _tc_json_args = None
                                # Send any unsent content before the tool call tag
                                unsent = accumulated[_content_sent_len:tc_start]
                                if unsent:
                                    chunk_data = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"content": unsent}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(chunk_data)}\n\n"
                                # The tool call text starts — buffer everything after the tag
                                _tool_call_buf = accumulated[tc_start + len(_TOOL_OPEN):]
                            else:
                                # Normal content token — send as content delta
                                # But check if we might be mid-tag (e.g. "<tool" at end)
                                tail = accumulated[-11:] if len(accumulated) >= 11 else accumulated
                                if any(tail.endswith(pt) for pt in _PARTIAL_TAGS):
                                    # Might be start of <tool_call> — hold this token
                                    continue
                                # Send all unsent content
                                unsent = accumulated[_content_sent_len:]
                                if unsent:
                                    chunk_data = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"content": unsent}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(chunk_data)}\n\n"
                                    _content_sent_len = len(accumulated)
                        else:
                            # Inside a tool call — buffer the text
                            _tool_call_buf += data

                            # Check if the tool call is complete
                            close_pos = _tool_call_buf.find("</function>")
                            tc_close = _tool_call_buf.find(_TOOL_CLOSE)

                            # Try to extract function name if we haven't yet
                            if not _tc_func_name:
                                fn_match = _FUNC_NAME_RE.search(_tool_call_buf)
                                if fn_match:
                                    _tc_func_name = fn_match.group(1).strip()
                                elif tc_close != -1:
                                    # No <function=...> tag found but tool call is complete.
                                    # Try JSON-style: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
                                    json_body = _tool_call_buf[:tc_close].strip()
                                    try:
                                        obj = json.loads(json_body)
                                        _tc_func_name = obj.get("name", "")
                                        _tc_json_args = obj.get("arguments", {})
                                        print(f"[server] 🔧 JSON-style tool call detected: func={_tc_func_name}, args={json.dumps(_tc_json_args)[:200]}", file=sys.stderr)
                                    except (json.JSONDecodeError, ValueError):
                                        print(f"[server] ⚠️ Tool call block has no <function=> and is not valid JSON: {repr(json_body[:200])}", file=sys.stderr)

                            # Send incremental tool_calls deltas
                            if _tc_func_name:
                                # Check if we parsed JSON-style args directly
                                if _tc_json_args is not None:
                                    current_args = json.dumps(_tc_json_args)
                                else:
                                    # XML-parameter style: parse from function body
                                    fn_tag_end = _tool_call_buf.find(">", _tool_call_buf.find("<function="))
                                    func_body = _tool_call_buf[fn_tag_end + 1:] if fn_tag_end != -1 else ""
                                    # Strip closing tags from body for parsing
                                    clean_body = func_body.replace("</function>", "").replace("</tool_call>", "")
                                    current_args = parse_partial_tool_args(clean_body)
                                # Debug: log what the model is generating inside the tool call
                                if tc_close != -1 or close_pos != -1:
                                    print(f"[server] 🔧 Tool call complete: func={_tc_func_name}, parsed_args={current_args[:200]}", file=sys.stderr)

                                if not _tc_name_sent:
                                    # First delta: send name + initial args
                                    tc_delta = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {
                                                "tool_calls": [{
                                                    "index": _tc_index,
                                                    "id": _tc_id,
                                                    "type": "function",
                                                    "function": {
                                                        "name": _tc_func_name,
                                                        "arguments": current_args,
                                                    }
                                                }]
                                            },
                                            "finish_reason": None,
                                        }],
                                    }
                                    yield f"data: {json.dumps(tc_delta)}\n\n"
                                    _tc_name_sent = True
                                    _tc_last_args_len = len(current_args)
                                elif len(current_args) > _tc_last_args_len:
                                    # Subsequent delta: send only the new portion of arguments
                                    # OpenAI format appends argument fragments
                                    tc_delta = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {
                                                "tool_calls": [{
                                                    "index": _tc_index,
                                                    "function": {
                                                        "arguments": current_args,
                                                    }
                                                }]
                                            },
                                            "finish_reason": None,
                                        }],
                                    }
                                    yield f"data: {json.dumps(tc_delta)}\n\n"
                                    _tc_last_args_len = len(current_args)

                            # If tool call block is complete, send final args and reset
                            if tc_close != -1:
                                # Send a final delta with the definitively parsed arguments
                                # to ensure the client has the correct values (earlier deltas
                                # from parse_partial_tool_args may have had empty/incomplete args)
                                if _tc_func_name:
                                    if _tc_json_args is not None:
                                        final_args = json.dumps(_tc_json_args)
                                    else:
                                        fn_tag_end = _tool_call_buf.find(">", _tool_call_buf.find("<function="))
                                        func_body = _tool_call_buf[fn_tag_end + 1:] if fn_tag_end != -1 else ""
                                        clean_body = func_body.replace("</function>", "").replace("</tool_call>", "")
                                        final_args = parse_partial_tool_args(clean_body)
                                    tc_final = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {
                                                "tool_calls": [{
                                                    "index": _tc_index,
                                                    "function": {
                                                        "arguments": final_args,
                                                    }
                                                }]
                                            },
                                            "finish_reason": None,
                                        }],
                                    }
                                    yield f"data: {json.dumps(tc_final)}\n\n"
                                _in_tool_call = False
                                _tool_call_buf = ""
                                _tc_index += 1
                                # Check if there's content after </tool_call>
                                after_close = accumulated[accumulated.rfind(_TOOL_CLOSE) + len(_TOOL_CLOSE):]
                                if after_close.strip():
                                    accumulated = after_close
                    elif kind == "stats":
                        stats_chunk = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": created, "model": _model_id,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                            "usage": {
                                "prompt_tokens": getattr(data, "prompt_tokens", 0),
                                "completion_tokens": getattr(data, "generation_tokens", 0),
                                "total_tokens": getattr(data, "total_tokens", 0),
                            },
                            "x_stats": {
                                "prompt_tps": round(getattr(data, "prompt_tps", 0), 2),
                                "generation_tps": round(getattr(data, "generation_tps", 0), 2),
                                "peak_memory_gb": round(getattr(data, "peak_memory", 0), 3),
                            },
                        }
                        yield f"data: {json.dumps(stats_chunk)}\n\n"
                    elif kind == "error":
                        yield f"event: error\ndata: {json.dumps({'error': data, 'type': 'server_error'})}\n\n"
                        break
                    elif kind == "done":
                        full_text = "".join(full_text_parts)
                        if has_tools:
                            tool_calls = parse_tool_calls(full_text)
                            # Debug: log the raw model output for tool call diagnosis
                            if tool_calls:
                                print(f"[server] 🔧 Final parse_tool_calls found {len(tool_calls)} call(s)", file=sys.stderr)
                                for i, tc in enumerate(tool_calls):
                                    print(f"[server]   [{i}] {tc['function']['name']}: {tc['function']['arguments'][:200]}", file=sys.stderr)
                            elif '<tool_call>' in full_text or 'read_file' in full_text:
                                # Model tried to make a tool call but parse failed
                                print(f"[server] ⚠️ Tool call parse FAILED. Raw text (last 500 chars): {repr(full_text[-500:])}", file=sys.stderr)
                            if tool_calls:
                                if _tc_index > 0:
                                    # Re-send the final definitively parsed tool calls
                                    # to ensure the client has correct arguments (the
                                    # incremental deltas may have had stale/empty values)
                                    for i, tc in enumerate(tool_calls):
                                        tc_final_chunk = {
                                            "id": cid, "object": "chat.completion.chunk",
                                            "created": created, "model": _model_id,
                                            "choices": [{
                                                "index": 0,
                                                "delta": {
                                                    "tool_calls": [{
                                                        "index": i,
                                                        "id": tc["id"],
                                                        "type": "function",
                                                        "function": {
                                                            "name": tc["function"]["name"],
                                                            "arguments": tc["function"]["arguments"],
                                                        }
                                                    }]
                                                },
                                                "finish_reason": None,
                                            }],
                                        }
                                        yield f"data: {json.dumps(tc_final_chunk)}\n\n"
                                    finish_chunk = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {},
                                            "finish_reason": "tool_calls",
                                        }],
                                    }
                                    yield f"data: {json.dumps(finish_chunk)}\n\n"
                                else:
                                    # Fallback: send all tool_calls at once (shouldn't happen normally)
                                    tc_chunk = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {"tool_calls": tool_calls},
                                            "finish_reason": "tool_calls",
                                        }],
                                    }
                                    yield f"data: {json.dumps(tc_chunk)}\n\n"
                                yield "data: [DONE]\n\n"
                                break

                        final = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": created, "model": _model_id,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        }
                        yield f"data: {json.dumps(final)}\n\n"
                        yield "data: [DONE]\n\n"
                        break

            _cleanup_images(images)

        # Aggressive post-request cache clearing to prevent memory accumulation
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
        except Exception:
            pass

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    # ── non-streaming ─────────────────────────────────────────────────────────
    if _model_is_vision:
        from mlx_vlm import generate
    else:
        from mlx_lm import generate

    prompt, kwargs, images = _build_prompt_and_kwargs(req)

    def _run_generate():
        result = generate(_model, _processor, prompt, **kwargs)
        if images:
            try:
                import mlx.core as mx
                mx.metal.clear_cache()
            except Exception:
                pass
        return result

    try:
        sem = _get_inference_semaphore()
        async with sem:
            result = await asyncio.get_event_loop().run_in_executor(None, _run_generate)
    except Exception as e:
        import traceback
        print(f"[server] ❌ Inference error ({type(e).__name__}): {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        try:
            import mlx.core as mx
            mem_active = mx.metal.get_active_memory() / (1024**3)
            mem_peak = mx.metal.get_peak_memory() / (1024**3)
            mem_cache = mx.metal.get_cache_memory() / (1024**3)
            print(f"[server] Metal memory — active: {mem_active:.2f} GB, peak: {mem_peak:.2f} GB, cache: {mem_cache:.2f} GB", file=sys.stderr)
        except Exception:
            pass
        _cleanup_images(images)
        raise HTTPException(500, f"Inference error: {str(e)}")
    _cleanup_images(images)

    # Post-request cache clearing for non-streaming path
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
    except Exception:
        pass

    response_text = result.text if hasattr(result, "text") else str(result)

    # check for tool calls in the response
    tool_calls = []
    finish_reason = "stop"
    content = response_text

    if has_tools:
        tool_calls = parse_tool_calls(response_text)
        if tool_calls:
            finish_reason = "tool_calls"
            content = strip_thinking(strip_tool_calls(response_text)) or None

    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": _model_id,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": getattr(result, "prompt_tokens", 0),
            "completion_tokens": getattr(result, "generation_tokens", 0),
            "total_tokens": getattr(result, "total_tokens", 0),
        },
        "x_stats": {
            "prompt_tps": round(getattr(result, "prompt_tps", 0), 2),
            "generation_tps": round(getattr(result, "generation_tps", 0), 2),
            "peak_memory_gb": round(getattr(result, "peak_memory", 0), 3),
        },
    }


if __name__ == "__main__":
    import uvicorn, argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--model", type=str, default=None)
    args = parser.parse_args()
    if args.model:
        load_model(args.model)
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info", loop="asyncio")
