"""Release provenance and failure tests; all GitHub HTTP requests are mocked."""

from copy import deepcopy
import http.client
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse


MODULE_PATH = Path(__file__).resolve().parents[1] / "published_release.py"
SPEC = importlib.util.spec_from_file_location("published_release", MODULE_PATH)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def workflow_run(**changes):
    value = {
        "id": 101,
        "head_sha": "a" * 40,
        "head_branch": "main",
        "status": "completed",
        "conclusion": "success",
        "event": "push",
        "path": ".github/workflows/docker-publish.yml",
        "created_at": "2026-09-22T10:00:00Z",
        "repository": {"full_name": "mikedim95/Garsone-Core"},
        "head_repository": {"full_name": "mikedim95/Garsone-Core"},
        "html_url": "https://untrusted.example/do-not-use",
    }
    value.update(changes)
    return value


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.opener_patch = patch.object(release.urllib.request, "build_opener")
        self.opener = self.opener_patch.start().return_value
        self.addCleanup(self.opener_patch.stop)

    def respond(self, *pages):
        self.opener.open.side_effect = [
            io.BytesIO(json.dumps({"workflow_runs": runs}).encode()) for runs in pages
        ]

    def test_resolves_full_sha_tag_and_canonical_provenance(self):
        self.respond([workflow_run()])
        result = release.resolve_release("core", token="private-test-token")
        self.assertEqual(result, {
            "component": "core",
            "sourceSha": "a" * 40,
            "imageTag": "mikedim95/garsone-core:stable-" + "a" * 40,
            "workflowRunId": 101,
            "workflowUrl": "https://github.com/mikedim95/Garsone-Core/actions/runs/101",
            "repository": "mikedim95/Garsone-Core",
            "channel": "stable",
        })
        request = self.opener.open.call_args.args[0]
        url = urllib.parse.urlsplit(request.full_url)
        self.assertEqual(url.scheme, "https")
        self.assertEqual(url.netloc, "api.github.com")
        self.assertEqual(url.path, "/repos/mikedim95/Garsone-Core/actions/workflows/docker-publish.yml/runs")
        self.assertEqual(urllib.parse.parse_qs(url.query)["branch"], ["main"])
        self.assertEqual(request.get_header("Authorization"), "Bearer private-test-token")
        self.assertEqual(self.opener.open.call_args.kwargs["timeout"], release.REQUEST_TIMEOUT)

    def test_selects_newest_creation_not_array_order_or_update_time(self):
        self.respond([
            workflow_run(id=110, created_at="2026-09-21T10:00:00Z", updated_at="2026-09-25T10:00:00Z"),
            workflow_run(id=111, head_sha="b" * 40, created_at="2026-09-23T10:00:00Z"),
            workflow_run(id=112, created_at="2026-09-22T10:00:00Z"),
        ])
        self.assertEqual(release.resolve_release("core")["workflowRunId"], 111)

    def test_front_stage_manual_build_resolves_canary_tag_and_documented_ref_suffix(self):
        self.respond([workflow_run(
            event="workflow_dispatch", head_branch="stage",
            repository={"full_name": "mikedim95/Garsone-Front"},
            head_repository={"full_name": "mikedim95/Garsone-Front"},
            path=".github/workflows/docker-publish.yml@stage",
        )])
        result = release.resolve_release("front", channel="stage")
        self.assertEqual(result["channel"], "stage")
        self.assertEqual(result["imageTag"], "mikedim95/garsone-front:canary-" + "a" * 40)
        request = self.opener.open.call_args.args[0]
        self.assertNotIn("Authorization", request.headers)
        self.assertIn("branch=stage", request.full_url)

    def test_rejects_wrong_workflow_ref_branch_fork_status_and_event(self):
        invalid_changes = [
            {"status": "in_progress"}, {"conclusion": "failure"},
            {"conclusion": "cancelled"}, {"event": "pull_request"},
            {"event": "pull_request_target"}, {"event": "schedule"},
            {"head_branch": "stage"}, {"head_branch": "feature/new-build"},
            {"repository": {"full_name": "someone/Garsone-Core"}},
            {"head_repository": {"full_name": "someone/Garsone-Core"}},
            {"head_repository": None}, {"repository": None},
            {"path": ".github/workflows/other.yml"},
            {"path": []},
            {"path": ".github/workflows/docker-publish.yml@stage"},
            {"head_sha": "a" * 7}, {"head_sha": "g" * 40},
            {"id": "101"}, {"id": True}, {"id": -1},
            {"created_at": "not-a-date"}, {"created_at": "2026-09-22T10:00:00"},
        ]
        for changes in invalid_changes:
            with self.subTest(changes=changes):
                self.respond([workflow_run(**changes)])
                with self.assertRaisesRegex(release.ReleaseError, "No successful"):
                    release.resolve_release("core")

    def test_exact_full_sha_filter_normalizes_case_and_checks_response(self):
        self.respond([workflow_run(head_sha="b" * 40), workflow_run(id=102)])
        result = release.resolve_release("core", source_sha="A" * 40)
        self.assertEqual(result["sourceSha"], "a" * 40)
        self.assertIn("head_sha=" + "a" * 40, self.opener.open.call_args.args[0].full_url)

    def test_missing_exact_sha_does_not_fall_back_to_latest(self):
        self.respond([workflow_run()])
        with self.assertRaisesRegex(release.ReleaseError, "No successful"):
            release.resolve_release("core", source_sha="b" * 40)

    def test_invalid_input_never_makes_network_request(self):
        for arguments in [
            ("nodes",), ([],), ("core", "canary"), ("core", []),
            ("core", "stable", "short"), ("core", "stable", 42),
            ("core", "stable", None, "token\nvalue"),
            ("core", "stable", None, "token\x00value"),
            ("core", "stable", None, "nonascii-\u00e9"),
            ("core", "stable", None, 12),
        ]:
            with self.subTest(arguments=arguments), self.assertRaises(release.ReleaseError):
                release.resolve_release(*arguments)
        self.opener.open.assert_not_called()

    def test_paginates_and_keeps_newest_valid_release(self):
        rejected = workflow_run(event="pull_request")
        self.respond([deepcopy(rejected) for _ in range(release.PAGE_SIZE)], [workflow_run()])
        self.assertEqual(release.resolve_release("core")["workflowRunId"], 101)
        self.assertEqual(self.opener.open.call_count, 2)
        self.assertIn("page=2", self.opener.open.call_args.args[0].full_url)

    def test_pagination_is_bounded(self):
        page = [workflow_run(event="pull_request") for _ in range(release.PAGE_SIZE)]
        self.respond(*[page for _ in range(release.MAX_PAGES)])
        with self.assertRaisesRegex(release.ReleaseError, "first 500 matching runs"):
            release.resolve_release("core")
        self.assertEqual(self.opener.open.call_count, release.MAX_PAGES)

    def test_http_errors_are_sanitized(self):
        for code in [301, 401, 403, 404, 429, 500]:
            with self.subTest(code=code):
                self.opener.open.side_effect = urllib.error.HTTPError(
                    "https://secret.example/token", code, "private-secret", {}, io.BytesIO(b"private-secret")
                )
                with self.assertRaises(release.ReleaseError) as caught:
                    release.resolve_release("core", token="private-secret")
                message = str(caught.exception)
                self.assertIn(f"HTTP {code}", message)
                self.assertNotIn("private-secret", message)
                self.assertNotIn("secret.example", message)

    def test_connection_errors_are_sanitized(self):
        for error in [urllib.error.URLError("proxy-password"), TimeoutError("secret"), OSError("secret"), http.client.IncompleteRead(b"secret")]:
            with self.subTest(error=type(error)):
                self.opener.open.side_effect = error
                with self.assertRaisesRegex(release.ReleaseError, "could not connect securely") as caught:
                    release.resolve_release("core")
                self.assertNotIn("secret", str(caught.exception))
                self.assertNotIn("proxy-password", str(caught.exception))

    def test_response_shape_and_size_are_checked(self):
        bodies = [b"invalid-json", b"\xff", b"[]", b"{}", b'{"workflow_runs": {}}', b"x" * (release.MAX_RESPONSE_BYTES + 1)]
        for body in bodies:
            with self.subTest(length=len(body)):
                self.opener.open.side_effect = [io.BytesIO(body)]
                with self.assertRaises(release.ReleaseError):
                    release.resolve_release("core")

    def test_redirect_handler_does_not_forward_credentials(self):
        self.assertIsNone(release._NoRedirect().redirect_request(None, None, 302, "Moved", {}, "https://elsewhere.example"))

    def test_cli_emits_json_and_reads_token_from_environment(self):
        self.respond([workflow_run()])
        with patch.dict(release.os.environ, {"GITHUB_TOKEN": "test-token"}, clear=True), patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(release.main(["core"]), 0)
        self.assertEqual(json.loads(output.getvalue())["component"], "core")
        self.assertEqual(self.opener.open.call_args.args[0].get_header("Authorization"), "Bearer test-token")

    def test_cli_failure_is_clean_and_nonzero(self):
        self.respond([])
        with patch("sys.stderr", new_callable=io.StringIO) as output:
            self.assertEqual(release.main(["core"]), 1)
        self.assertIn("No successful", output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())


if __name__ == "__main__":
    unittest.main()
