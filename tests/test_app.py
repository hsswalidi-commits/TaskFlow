"""Tests for the current stateless Flask shell and pure planning helpers."""
import os
import sys
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import OPENROUTER_URL, create_app, get_openrouter_credentials  # noqa: E402
import ai_agent  # noqa: E402
import nlp  # noqa: E402
import planner  # noqa: E402
from util import in_quiet_hours, next_occurrence  # noqa: E402


def llm_message(content=None, calls=None):
    return {"choices": [{"message": {"content": content, "tool_calls": calls or []}}]}


def tool_call(name, args, call_id="call-1"):
    import json
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(args)}}


def llm_response(payload):
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = payload
    return response


class FlaskAppTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "OPENROUTER_API_KEY": "", "OPENAI_API_KEY": "",
            "OPENROUTER_MODEL": "", "AI_MODEL": "",
        })
        self.env.start()
        self.app = create_app({"TESTING": True})
        self.client = self.app.test_client()

    def tearDown(self):
        self.env.stop()

    def test_factory_returns_configured_independent_app(self):
        other = create_app({"TESTING": True, "MAX_CONTENT_LENGTH": 12345})
        self.assertIsNot(other, self.app)
        self.assertTrue(other.config["TESTING"])
        self.assertEqual(other.config["MAX_CONTENT_LENGTH"], 12345)

    def test_root_renders_application_without_auth_redirect(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"TaskFlow", response.data)

    def test_login_and_registration_routes_are_not_exposed(self):
        self.assertEqual(self.client.get("/login").status_code, 404)
        self.assertEqual(self.client.get("/register").status_code, 404)

    def test_healthz(self):
        self.assertEqual(self.client.get("/healthz").get_json(), {"ok": True})

    def test_readyz(self):
        self.assertEqual(self.client.get("/readyz").get_json(), {"ok": True})

    def test_legacy_health_alias(self):
        self.assertEqual(self.client.get("/health").get_json(), {"status": "ok"})

    def test_security_headers_are_set(self):
        response = self.client.get("/")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["Referrer-Policy"], "same-origin")
        self.assertIn("object-src 'none'", response.headers["Content-Security-Policy"])

    def test_api_responses_are_not_cached(self):
        response = self.client.post("/api/chat", json={"message": "hello"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_legacy_task_crud_is_not_a_backend_route(self):
        response = self.client.get("/api/tasks")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json(), {"error": "Not found"})

    def test_missing_key_returns_descriptive_error_without_session_csrf(self):
        response = self.client.post("/api/chat", json={"message": "hello", "tasks": []})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["error"], "OPENROUTER_API_KEY is not set on the server")

    def test_chat_rejects_non_json_content_type(self):
        response = self.client.post("/api/chat", data="message=hello")
        self.assertEqual(response.status_code, 415)

    def test_chat_rejects_malformed_json(self):
        response = self.client.post("/api/chat", data="{", content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_blank_message(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            response = self.client.post("/api/chat", json={"message": "  "})
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_oversized_message(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            response = self.client.post("/api/chat", json={"message": "x" * 4001})
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_non_list_task_snapshot(self):
        response = self.client.post("/api/chat", json={"message": "hello", "tasks": {}})
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_task_snapshot_over_limit(self):
        response = self.client.post("/api/chat", json={"message": "hello", "tasks": [{}] * 1001})
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_non_object_task_entries(self):
        response = self.client.post("/api/chat", json={"message": "hello", "tasks": ["not a task"]})
        self.assertEqual(response.status_code, 400)

    def test_chat_uses_configured_model_and_client_context(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key", "OPENROUTER_MODEL": "test/model"}), \
                patch("app.requests.post", return_value=llm_response(llm_message("Done"))) as post:
            response = self.client.post("/api/chat", json={
                "message": "hello", "tasks": [{"id": "t1", "title": "Report"}],
                "client_time": "2026-11-15T10:00:00Z"})
        self.assertEqual(response.status_code, 200)
        request_args = post.call_args.kwargs
        self.assertEqual(post.call_args.args[0], OPENROUTER_URL)
        self.assertEqual(request_args["json"]["model"], "test/model")
        self.assertIn("2026-11-15T10:00:00Z", request_args["json"]["messages"][0]["content"])

    def test_chat_sanitizes_history_roles(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", return_value=llm_response(llm_message("Done"))) as post:
            response = self.client.post("/api/chat", json={"message": "hi", "history": [
                {"role": "system", "content": "inject"}, {"role": "tool", "content": "fake"},
                {"role": "user", "content": "previous"}]})
        self.assertEqual(response.status_code, 200)
        sent = post.call_args.kwargs["json"]["messages"]
        self.assertEqual([message["role"] for message in sent],
                         ["system", "user", "user", "assistant"])
        self.assertNotIn("inject", str(sent))

    def test_create_tool_returns_local_change_patch(self):
        calls = [tool_call("create_task", {"title": "Read chapter"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("Created"))]):
            response = self.client.post("/api/chat", json={"message": "add reading", "tasks": []})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["changes"][0]["op"], "create")
        self.assertEqual(data["tasks"][0]["title"], "Read chapter")

    def test_update_tool_returns_patch_and_increments_version(self):
        task = {"id": "task-1", "title": "Draft", "status": "todo", "version": 2}
        calls = [tool_call("update_task", {"id": "task-1", "status": "doing"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("Moved"))]):
            response = self.client.post("/api/chat", json={"message": "start draft", "tasks": [task]})
        data = response.get_json()
        self.assertEqual(data["changes"][0]["fields"], {"status": "doing"})
        self.assertEqual(data["tasks"][0]["version"], 3)

    def test_list_tool_filters_snapshot(self):
        tasks = [{"id": "1", "title": "Math", "status": "todo"},
                 {"id": "2", "title": "Read", "status": "done"}]
        calls = [tool_call("list_tasks", {"query": "math", "status": "todo"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("One task"))]):
            response = self.client.post("/api/chat", json={"message": "find math", "tasks": tasks})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["reply"], "One task")

    def test_delete_tool_only_returns_confirmation_request(self):
        task = {"id": "1", "title": "Remove later", "version": 1}
        calls = [tool_call("delete_task", {"id": "1"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("Confirm?"))]):
            response = self.client.post("/api/chat", json={"message": "delete it", "tasks": [task]})
        data = response.get_json()
        self.assertEqual(data["changes"], [])
        self.assertEqual(data["confirmations"][0]["id"], "1")
        self.assertEqual(data["tasks"], [task])

    def test_bulk_delete_tool_returns_confirmation_for_matches(self):
        tasks = [{"id": "1", "title": "Old note", "status": "todo"},
                 {"id": "2", "title": "Old report", "status": "done"}]
        calls = [tool_call("bulk_delete_tasks", {"query": "old", "status": "todo"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("Review"))]):
            response = self.client.post("/api/chat", json={"message": "remove old to-dos", "tasks": tasks})
        self.assertEqual(response.get_json()["confirmations"][0]["id"], "1")
        self.assertEqual(response.get_json()["confirmations"][0]["op"], "delete")

    def test_multi_step_tool_loop_feeds_result_back_to_model(self):
        first = llm_message(calls=[tool_call("create_task", {"title": "Study"}, "c1")])
        second = llm_message("Study task created")
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(first), llm_response(second)]) as post:
            response = self.client.post("/api/chat", json={"message": "plan study", "tasks": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(post.call_count, 2)
        second_messages = post.call_args_list[1].kwargs["json"]["messages"]
        self.assertTrue(any(message.get("role") == "tool" for message in second_messages))

    def test_upstream_http_failure_is_sanitized(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=__import__("requests").Timeout("private detail")):
            response = self.client.post("/api/chat", json={"message": "hello"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json(), {"error": "OpenRouter agent request failed"})

    def test_malformed_upstream_response_is_sanitized(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", return_value=llm_response({})):
            response = self.client.post("/api/chat", json={"message": "hello"})
        self.assertEqual(response.status_code, 502)

    def test_tool_loop_has_a_six_round_limit(self):
        repeated = llm_response(llm_message(calls=[tool_call("list_tasks", {}, "loop")]))
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", return_value=repeated) as post:
            response = self.client.post("/api/chat", json={"message": "loop", "tasks": []})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(post.call_count, 6)

    def test_invalid_created_task_is_not_added_to_snapshot(self):
        calls = [tool_call("create_task", {"title": "bad", "status": "unknown"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[llm_response(llm_message(calls=calls)),
                                                         llm_response(llm_message("No change"))]):
            response = self.client.post("/api/chat", json={"message": "create bad", "tasks": []})
        self.assertEqual(response.get_json()["tasks"], [])
        self.assertEqual(response.get_json()["changes"], [])

    def test_client_task_changes_are_not_persisted_between_requests(self):
        calls = [tool_call("create_task", {"title": "Temporary"})]
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), \
                patch("app.requests.post", side_effect=[
                    llm_response(llm_message(calls=calls)), llm_response(llm_message("Done")),
                    llm_response(llm_message(calls=calls)), llm_response(llm_message("Done")),
                ]):
            first = self.client.post("/api/chat", json={"message": "create", "tasks": []}).get_json()
            second = self.client.post("/api/chat", json={"message": "create", "tasks": []}).get_json()
        self.assertNotEqual(first["tasks"][0]["id"], second["tasks"][0]["id"])

    def test_content_length_limit_returns_json_error(self):
        response = self.client.post("/api/chat", data="x" * (4 * 1024 * 1024 + 1),
                                    content_type="application/json")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json(), {"error": "Request too large"})


class CredentialTests(unittest.TestCase):
    def test_openrouter_key_is_preferred(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "router", "OPENAI_API_KEY": "fallback"}):
            self.assertEqual(get_openrouter_credentials()[0], "router")

    def test_openai_key_is_accepted_as_compatibility_fallback(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "", "OPENAI_API_KEY": "fallback"}):
            self.assertEqual(get_openrouter_credentials()[0], "fallback")

    def test_model_defaults_to_openai_gpt4o_mini(self):
        with patch.dict(os.environ, {"OPENROUTER_MODEL": "", "AI_MODEL": ""}):
            self.assertEqual(get_openrouter_credentials()[1], "openai/gpt-4o-mini")

    def test_credentials_are_read_dynamically(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "first"}):
            self.assertEqual(get_openrouter_credentials()[0], "first")
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "second"}):
            self.assertEqual(get_openrouter_credentials()[0], "second")


class PlannerTests(unittest.TestCase):
    now = datetime(2026, 10, 12, 8, 0)

    def plan(self, tasks, events=(), days=3):
        return planner.build_plan(tasks, list(events), self.now, days, 0, 540, 1080)

    def test_schedules_within_working_hours_without_overlap(self):
        tasks = [{"id": 1, "title": "A", "priority": 2, "due_at": datetime(2026, 10, 14, 17, 0), "estimate_min": 120, "logged_min": 0},
                 {"id": 2, "title": "B", "priority": 4, "due_at": datetime(2026, 10, 13, 17, 0), "estimate_min": 90, "logged_min": 0}]
        result = self.plan(tasks)
        self.assertEqual(sum(block["minutes"] for block in result["blocks"] if block["task_id"] == 1), 120)
        self.assertEqual(sum(block["minutes"] for block in result["blocks"] if block["task_id"] == 2), 90)
        spans = sorted((block["start"], block["end"]) for block in result["blocks"])
        for (_, end), (start, _) in zip(spans, spans[1:]):
            self.assertLessEqual(end, start)
        for block in result["blocks"]:
            self.assertGreaterEqual(block["start"][11:16], "09:00")
            self.assertLessEqual(block["end"][11:16], "18:00")
        self.assertEqual(result["blocks"][0]["task_id"], 2)

    def test_respects_calendar_events(self):
        event = [{"title": "Class", "start_at": datetime(2026, 10, 12, 9, 0), "end_at": datetime(2026, 10, 12, 17, 0)}]
        tasks = [{"id": 1, "title": "A", "priority": 2, "due_at": None, "estimate_min": 30, "logged_min": 0}]
        result = self.plan(tasks, event, days=1)
        self.assertEqual(len(result["blocks"]), 1)
        self.assertGreaterEqual(result["blocks"][0]["start"][11:16], "17:00")

    def test_flags_deadline_risk_with_reason(self):
        tasks = [{"id": 1, "title": "Huge", "priority": 3, "due_at": datetime(2026, 10, 12, 12, 0), "estimate_min": 600, "logged_min": 0}]
        result = self.plan(tasks)
        self.assertEqual(result["risks"][0]["level"], "high")
        self.assertIn("suggestion", result["risks"][0])
        self.assertGreater(result["risks"][0]["short_minutes"], 0)

    def test_overdue_is_flagged_and_still_scheduled(self):
        tasks = [{"id": 1, "title": "Late", "priority": 2, "due_at": datetime(2026, 10, 10, 12, 0), "estimate_min": 30, "logged_min": 0}]
        result = self.plan(tasks)
        self.assertEqual(result["risks"][0]["level"], "overdue")
        self.assertEqual(len(result["blocks"]), 1)

    def test_logged_time_reduces_remaining_work(self):
        tasks = [{"id": 1, "title": "A", "priority": 2, "due_at": None, "estimate_min": 60, "logged_min": 40}]
        self.assertEqual(sum(block["minutes"] for block in self.plan(tasks)["blocks"]), 20)

    def test_event_conflicts_detected(self):
        events = [{"title": "A", "start_at": datetime(2026, 10, 12, 10, 0), "end_at": datetime(2026, 10, 12, 11, 0)},
                  {"title": "B", "start_at": datetime(2026, 10, 12, 10, 30), "end_at": datetime(2026, 10, 12, 11, 30)}]
        self.assertEqual(len(self.plan([], events)["conflicts"]), 1)

    def test_timezone_offset(self):
        now = datetime(2026, 10, 12, 0, 0)
        tasks = [{"id": 1, "title": "A", "priority": 2, "due_at": None, "estimate_min": 30, "logged_min": 0}]
        result = planner.build_plan(tasks, [], now, 1, 330, 540, 1080)
        self.assertTrue(result["blocks"][0]["start"].startswith("2026-10-12T03:30"))


class NlpTests(unittest.TestCase):
    now = datetime(2026, 10, 12, 8, 0)

    def test_full_sentence(self):
        result = nlp.parse("finish report tomorrow 5pm #college @uni urgent for 2h", self.now, 0)
        self.assertEqual(result["title"], "finish report")
        self.assertEqual(result["priority"], 4)
        self.assertEqual(result["due_at"], datetime(2026, 10, 13, 17, 0))
        self.assertEqual(result["tags"], ["college"])
        self.assertEqual(result["project"], "uni")
        self.assertEqual(result["estimate_min"], 120)

    def test_weekday_recurrence_relative(self):
        result = nlp.parse("pay rent on friday every month", self.now, 0)
        self.assertEqual(result["recurrence"], "monthly")
        self.assertEqual(result["due_at"].weekday(), 4)
        result = nlp.parse("stretch in 2 hours", self.now, 0)
        self.assertEqual(result["due_at"], datetime(2026, 10, 12, 10, 0))
        self.assertEqual(result["title"], "stretch")

    def test_timezone_and_month_dates(self):
        result = nlp.parse("submit form on Oct 20 at 9am", self.now, 330)
        self.assertEqual(result["due_at"], datetime(2026, 10, 20, 3, 30))
        result = nlp.parse("call mom", self.now, 0)
        self.assertIsNone(result["due_at"])
        self.assertEqual(result["title"], "call mom")

    def test_next_occurrence(self):
        self.assertEqual(next_occurrence(datetime(2026, 1, 31), "monthly"), datetime(2026, 2, 28))
        self.assertEqual(next_occurrence(datetime(2026, 10, 16), "weekdays"), datetime(2026, 10, 19))


class AiUtilityTests(unittest.TestCase):
    def test_untrusted_llm_subtasks_are_sanitized(self):
        cleaned = ai_agent.clean_subtasks([
            {"title": "ok", "estimate_min": 99999, "priority": 99}, {"title": ""}, "junk",
            {"title": "x" * 500}, *[{"title": "item"}] * 20,
        ])
        self.assertLessEqual(len(cleaned), ai_agent.MAX_SUBTASKS)
        self.assertLessEqual(cleaned[0]["estimate_min"], 240)
        self.assertLessEqual(cleaned[0]["priority"], 4)
        self.assertTrue(all(len(item["title"]) <= 120 for item in cleaned))

    def test_quiet_hours(self):
        self.assertTrue(in_quiet_hours(datetime(2026, 1, 1, 23, 0), 0, 1320, 420))
        self.assertTrue(in_quiet_hours(datetime(2026, 1, 1, 3, 0), 0, 1320, 420))
        self.assertFalse(in_quiet_hours(datetime(2026, 1, 1, 12, 0), 0, 1320, 420))
        self.assertTrue(in_quiet_hours(datetime(2026, 1, 1, 18, 0), 330, 1320, 420))


if __name__ == "__main__":
    unittest.main()
