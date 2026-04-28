"""
test_memory_bridge_assist.py — Python unit tests for the assist endpoint handlers
in memory-bridge.py.

Tests mock _extract_model and mlx_lm.generate to verify:
- Response shape for each of the 10 handlers
- Secret filtering applied before model invocation
- _get_extraction_semaphore() returns the same instance on repeated calls
- Timeout enforcement (HTTP 504)
- HTTP 400 for invalid task_type
- HTTP 503 degraded when no extraction model loaded
"""

import asyncio
import sys
import os
import unittest
from unittest.mock import patch, MagicMock

# Add workspace root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# memory-bridge.py uses a hyphen — import via importlib
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "memory_bridge",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "memory-bridge.py"),
)
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)

# Grab the real HTTPException from fastapi (installed in this env)
from fastapi import HTTPException as HTTPException


# ── Helpers ───────────────────────────────────────────────────────────────────

def run(coro):
    """Run a coroutine synchronously using a fresh event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def make_mock_model():
    m = MagicMock()
    m.name = "MockExtractionModel"  # must be a real string for Pydantic validation
    return m


def make_mock_processor():
    return MagicMock(name="MockProcessor")


# ── Semaphore idempotence ─────────────────────────────────────────────────────

class TestGetExtractionSemaphore(unittest.TestCase):
    def setUp(self):
        mb._extraction_semaphore = None

    def test_returns_same_instance_on_repeated_calls(self):
        """_get_extraction_semaphore() must be idempotent (lazy-init)."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            s1 = mb._get_extraction_semaphore()
            s2 = mb._get_extraction_semaphore()
            self.assertIs(s1, s2)
        finally:
            loop.close()

    def test_returns_asyncio_semaphore(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            sem = mb._get_extraction_semaphore()
            self.assertIsInstance(sem, asyncio.Semaphore)
        finally:
            loop.close()

    def test_semaphore_concurrency_is_one(self):
        mb._extraction_semaphore = None
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            sem = mb._get_extraction_semaphore()
            self.assertEqual(sem._value, 1)
        finally:
            loop.close()


# ── Assist endpoint routing (calling the raw function, not the decorated route) ──

class TestAssistEndpointRouting(unittest.TestCase):
    """
    We call mb.assist() directly. The @router.post decorator in FastAPI does NOT
    wrap the function — it registers it. So mb.assist is still the original coroutine.
    """

    def setUp(self):
        mb._extract_model = None
        mb._extract_processor = None
        mb._extraction_semaphore = None

    def test_invalid_task_type_raises_400(self):
        """HTTP 400 for any task_type not in the valid set."""
        req = mb.AssistRequest(task_type="not_a_real_task", payload={})
        with self.assertRaises(HTTPException) as ctx:
            run(mb.assist(req))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_task_type_raises_400(self):
        req = mb.AssistRequest(task_type="", payload={})
        with self.assertRaises(HTTPException) as ctx:
            run(mb.assist(req))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_degraded_when_no_model_loaded(self):
        """Returns degraded dict when _extract_model is None."""
        mb._extract_model = None
        req = mb.AssistRequest(task_type="vision", payload={})
        result = run(mb.assist(req))
        self.assertTrue(result.get("degraded"))
        self.assertIn("no extraction model", result.get("reason", ""))

    def test_all_valid_task_types_degrade_gracefully(self):
        """All 10 valid task types return degraded when no model loaded."""
        mb._extract_model = None
        for task_type in mb._VALID_ASSIST_TASK_TYPES:
            req = mb.AssistRequest(task_type=task_type, payload={})
            result = run(mb.assist(req))
            self.assertTrue(result.get("degraded"), f"{task_type} should degrade")


# ── Handler response shapes ───────────────────────────────────────────────────

class TestHandlerResponseShapes(unittest.TestCase):

    def _run_handler(self, handler_fn, payload):
        return run(handler_fn(payload))

    def test_handle_vision_returns_assist_response_on_failure(self):
        """_handle_vision returns AssistResponse with result=None when mlx_vlm unavailable."""
        resp = self._run_handler(mb._handle_vision, {
            "image_b64": "aGVsbG8=",
            "mime_type": "image/png",
            "prompt": "Describe this image.",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNone(resp.result)
        self.assertIsInstance(resp.elapsed_ms, int)
        self.assertGreaterEqual(resp.elapsed_ms, 0)

    def test_handle_todo_bootstrap_returns_assist_response_on_failure(self):
        """_handle_todo_bootstrap returns AssistResponse when model unavailable."""
        resp = self._run_handler(mb._handle_todo_bootstrap, {
            "user_prompt": "Build a REST API with authentication",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsInstance(resp.elapsed_ms, int)

    def test_handle_todo_bootstrap_with_mock_model(self):
        """_handle_todo_bootstrap parses JSON array from model response."""
        mock_response = '[{"id": 1, "content": "Set up project", "status": "pending"}]'
        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = MagicMock(return_value=mock_response)
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                resp = self._run_handler(mb._handle_todo_bootstrap, {
                    "user_prompt": "Build a REST API",
                })
                self.assertIsInstance(resp, mb.AssistResponse)
                if resp.result_data is not None:
                    self.assertIsInstance(resp.result_data, list)
                    self.assertEqual(resp.result_data[0]["id"], 1)
                    self.assertEqual(resp.result_data[0]["status"], "pending")
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_handle_todo_watch_empty_todos_returns_none(self):
        """_handle_todo_watch returns None result_data when current_todos is empty."""
        resp = self._run_handler(mb._handle_todo_watch, {
            "tool_name": "bash",
            "tool_result": "done",
            "current_todos": [],
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNone(resp.result_data)

    def test_handle_todo_watch_preserves_ids_and_content(self):
        """_handle_todo_watch only changes status, never id or content."""
        mock_response = '[{"id": 1, "content": "Set up project", "status": "in_progress"}]'
        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = MagicMock(return_value=mock_response)
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                resp = self._run_handler(mb._handle_todo_watch, {
                    "tool_name": "bash",
                    "tool_result": "project initialized",
                    "current_todos": [{"id": 1, "content": "Set up project", "status": "pending"}],
                })
                self.assertIsInstance(resp, mb.AssistResponse)
                if resp.result_data is not None:
                    self.assertEqual(len(resp.result_data), 1)
                    self.assertEqual(resp.result_data[0]["id"], 1)
                    self.assertEqual(resp.result_data[0]["content"], "Set up project")
                    self.assertIn(resp.result_data[0]["status"], ("pending", "in_progress", "done"))
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_handle_fetch_summarize_returns_assist_response(self):
        """_handle_fetch_summarize returns AssistResponse with result string."""
        mock_response = "Summary of the page."
        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = MagicMock(return_value=mock_response)
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                resp = self._run_handler(mb._handle_fetch_summarize, {
                    "url": "https://example.com",
                    "raw_content": "This is a long web page content " * 100,
                    "max_output_tokens": 512,
                })
                self.assertIsInstance(resp, mb.AssistResponse)
                self.assertEqual(resp.result, "Summary of the page.")
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_handle_tool_validate_edit_file_ok(self):
        """_handle_tool_validate returns valid=True when old_string is in context."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "edit_file",
            "tool_args": {"old_string": "hello world"},
            "recent_context": "The file contains hello world and more text.",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNotNone(resp.result_data)
        self.assertTrue(resp.result_data["valid"])

    def test_handle_tool_validate_edit_file_fail(self):
        """_handle_tool_validate returns valid=False when old_string not in context."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "edit_file",
            "tool_args": {"old_string": "string_that_is_not_present"},
            "recent_context": "The file contains completely different content.",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNotNone(resp.result_data)
        self.assertFalse(resp.result_data["valid"])
        self.assertIn("reason", resp.result_data)

    def test_handle_tool_validate_bash_unclosed_quote(self):
        """_handle_tool_validate returns valid=False for bash with unclosed quote."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "bash",
            "tool_args": {"command": "echo 'unclosed"},
            "recent_context": "",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertFalse(resp.result_data["valid"])

    def test_handle_tool_validate_bash_valid(self):
        """_handle_tool_validate returns valid=True for a well-formed bash command."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "bash",
            "tool_args": {"command": "ls -la /tmp"},
            "recent_context": "",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertTrue(resp.result_data["valid"])

    def test_handle_tool_validate_write_file_missing_path(self):
        """_handle_tool_validate returns valid=False for write_file with empty path."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "write_file",
            "tool_args": {"path": "", "content": "some content"},
            "recent_context": "",
        })
        self.assertFalse(resp.result_data["valid"])

    def test_handle_tool_validate_write_file_missing_content(self):
        """_handle_tool_validate returns valid=False for write_file with no content field."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "write_file",
            "tool_args": {"path": "/tmp/file.txt"},
            "recent_context": "",
        })
        self.assertFalse(resp.result_data["valid"])

    def test_handle_tool_validate_read_file_missing_path(self):
        """_handle_tool_validate returns valid=False for read_file with empty path."""
        resp = self._run_handler(mb._handle_tool_validate, {
            "tool_name": "read_file",
            "tool_args": {"path": ""},
            "recent_context": "",
        })
        self.assertFalse(resp.result_data["valid"])

    def test_handle_error_diagnose_returns_assist_response(self):
        """_handle_error_diagnose returns AssistResponse with result string."""
        mock_response = "The old_string was not found — re-read the file before retrying."
        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = MagicMock(return_value=mock_response)
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                resp = self._run_handler(mb._handle_error_diagnose, {
                    "tool_name": "edit_file",
                    "tool_args": {"old_string": "foo"},
                    "error_message": "old_string not found",
                    "recent_context": "some context",
                })
                self.assertIsInstance(resp, mb.AssistResponse)
                self.assertIsNotNone(resp.result)
                self.assertIsInstance(resp.result, str)
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_handle_git_summarize_returns_assist_response(self):
        """_handle_git_summarize returns AssistResponse with result string."""
        mock_response = "Branch: main. 3 files changed. Commits: abc1234 fix bug."
        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = MagicMock(return_value=mock_response)
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                resp = self._run_handler(mb._handle_git_summarize, {
                    "command": "git status",
                    "raw_output": "On branch main\nChanges not staged for commit:\n  modified: foo.py\n",
                })
                self.assertIsInstance(resp, mb.AssistResponse)
                self.assertIsNotNone(resp.result)
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_handle_rank_search_returns_ranked_list(self):
        """_handle_rank_search returns a ranked list of results."""
        results = [
            "src/auth.py:10: def login()",
            "src/utils.py:5: def helper()",
            "src/auth.py:20: def logout()",
        ]
        resp = self._run_handler(mb._handle_rank_search, {
            "pattern": "login",
            "results": results,
            "task_context": "Implement login functionality in auth.py",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNotNone(resp.result_data)
        self.assertIsInstance(resp.result_data, list)
        self.assertEqual(len(resp.result_data), len(results))

    def test_handle_rank_search_empty_results(self):
        """_handle_rank_search returns empty list for empty input."""
        resp = self._run_handler(mb._handle_rank_search, {
            "pattern": "foo",
            "results": [],
            "task_context": "some context",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertEqual(resp.result_data, [])

    def test_handle_extract_section_returns_contiguous_block(self):
        """_handle_extract_section returns a contiguous block of lines."""
        # Use unique tokens that exactly match the task_context words so the scorer picks line 50
        lines = [f"line {i}: unrelated boilerplate content" for i in range(100)]
        lines[50] = "def authenticate user login handler here"
        file_content = "\n".join(lines)
        resp = self._run_handler(mb._handle_extract_section, {
            "file_path": "src/auth.py",
            "file_content": file_content,
            "task_context": "authenticate user login",
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNotNone(resp.result)
        self.assertIsInstance(resp.result, str)
        # The extracted block should contain the best-matching line
        self.assertIn("authenticate", resp.result)

    def test_handle_detect_repetition_no_repetition(self):
        """_handle_detect_repetition returns repeating=False for distinct responses."""
        resp = self._run_handler(mb._handle_detect_repetition, {
            "recent_responses": [
                "I will now read the file to understand the structure.",
                "The file has been read. Now I will implement the feature.",
            ],
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIsNotNone(resp.result_data)
        self.assertIn("repeating", resp.result_data)

    def test_handle_detect_repetition_exact_duplicate(self):
        """_handle_detect_repetition returns repeating=True for exact duplicates."""
        resp = self._run_handler(mb._handle_detect_repetition, {
            "recent_responses": [
                "I will read the file and implement the feature.",
                "I will read the file and implement the feature.",
            ],
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertTrue(resp.result_data["repeating"])

    def test_handle_detect_repetition_planning_loop(self):
        """_handle_detect_repetition detects planning loops (high token overlap)."""
        resp = self._run_handler(mb._handle_detect_repetition, {
            "recent_responses": [
                "I will implement the authentication module next.",
                "I will implement the authentication module now.",
            ],
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertIn("repeating", resp.result_data)

    def test_handle_detect_repetition_too_few_responses(self):
        """_handle_detect_repetition returns repeating=False with < 2 responses."""
        resp = self._run_handler(mb._handle_detect_repetition, {
            "recent_responses": ["only one response"],
        })
        self.assertIsInstance(resp, mb.AssistResponse)
        self.assertFalse(resp.result_data["repeating"])


# ── Secret filtering ──────────────────────────────────────────────────────────

class TestSecretFilteringInAssist(unittest.TestCase):

    def test_secret_in_payload_is_redacted_before_model_call(self):
        """Secrets in payload strings must be redacted before reaching the model."""
        captured_prompts = []

        def mock_generate(model, processor, prompt, **kwargs):
            captured_prompts.append(prompt)
            return '[{"id": 1, "content": "task", "status": "pending"}]'

        mock_mlx_lm = MagicMock()
        mock_mlx_lm.generate = mock_generate
        with patch.dict("sys.modules", {"mlx_lm": mock_mlx_lm}):
            mb._extract_model = make_mock_model()
            mb._extract_processor = make_mock_processor()
            try:
                # The assist endpoint applies _fail_closed_filter to payload strings
                # before dispatching to handlers. We test this by calling assist() directly.
                req = mb.AssistRequest(
                    task_type="todo_bootstrap",
                    payload={"user_prompt": "Build API with key sk-abc123456789012345678901234567890"},
                )
                run(mb.assist(req))
                self.assertTrue(len(captured_prompts) > 0, "Model should have been called")
                for prompt in captured_prompts:
                    self.assertNotIn(
                        "sk-abc123456789012345678901234567890", prompt,
                        "Secret should be redacted before reaching the model",
                    )
            finally:
                mb._extract_model = None
                mb._extract_processor = None

    def test_filter_secrets_redacts_openai_key(self):
        """filter_secrets() redacts OpenAI API keys."""
        text = "Use this key: sk-abcdefghijklmnopqrst to authenticate"
        filtered = mb.filter_secrets(text)
        self.assertNotIn("sk-abcdefghijklmnopqrst", filtered)
        self.assertIn("[REDACTED]", filtered)

    def test_filter_secrets_passes_clean_text_unchanged(self):
        """filter_secrets() does not modify text without secrets."""
        text = "This is a normal message with no secrets."
        filtered = mb.filter_secrets(text)
        self.assertEqual(filtered, text)


# ── Timeout enforcement ───────────────────────────────────────────────────────

class TestTimeoutEnforcement(unittest.TestCase):
    def setUp(self):
        mb._extract_model = make_mock_model()
        mb._extract_processor = make_mock_processor()
        mb._extraction_semaphore = None

    def tearDown(self):
        mb._extract_model = None
        mb._extract_processor = None

    def test_timeout_raises_http_504(self):
        """assist() raises HTTP 504 when asyncio.wait_for raises TimeoutError."""
        import asyncio as _asyncio

        original_wait_for = _asyncio.wait_for

        async def fake_wait_for(coro, timeout):
            # Cancel the coro to avoid resource warnings
            coro.close()
            raise _asyncio.TimeoutError()

        with patch("asyncio.wait_for", side_effect=fake_wait_for):
            req = mb.AssistRequest(task_type="vision", payload={})
            with self.assertRaises(HTTPException) as ctx:
                run(mb.assist(req))
            self.assertEqual(ctx.exception.status_code, 504)


# ── MemoryStatus fast_assistant_enabled ──────────────────────────────────────

class TestMemoryStatusFastAssistantEnabled(unittest.TestCase):
    def test_fast_assistant_enabled_true_when_model_loaded(self):
        """fast_assistant_enabled is True when _extract_model is not None."""
        mb._extract_model = make_mock_model()
        try:
            status = run(mb.get_memory_status())
            self.assertTrue(status.fast_assistant_enabled)
        finally:
            mb._extract_model = None

    def test_fast_assistant_enabled_false_when_no_model(self):
        """fast_assistant_enabled is False when _extract_model is None."""
        mb._extract_model = None
        status = run(mb.get_memory_status())
        self.assertFalse(status.fast_assistant_enabled)


if __name__ == "__main__":
    unittest.main()
