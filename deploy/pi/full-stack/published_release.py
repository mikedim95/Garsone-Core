#!/usr/bin/env python3
"""Resolve successful GitHub image builds to their commit-specific Docker Hub tags.

This does not read the optional Render release catalogue or moving Docker tags.
The updater must pull the returned tag and record its digest before activating it.
"""

import argparse
from datetime import datetime, timezone
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


REPOSITORIES = {
    "core": "mikedim95/Garsone-Core",
    "front": "mikedim95/Garsone-Front",
}
CHANNEL_BRANCHES = {"stable": "main", "stage": "stage"}
CHANNEL_TAGS = {"stable": "stable", "stage": "canary"}
WORKFLOW_FILE = "docker-publish.yml"
WORKFLOW_PATH = ".github/workflows/" + WORKFLOW_FILE
API_ROOT = "https://api.github.com"
REQUEST_TIMEOUT = 10
MAX_PAGES = 5
PAGE_SIZE = 100
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}\Z")


class ReleaseError(RuntimeError):
    """A release could not be verified; messages are safe to show to an operator."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Never forward a caller's GitHub credential to a redirect destination.
        return None


def _request_json(url, token):
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "garsone-pi-release-updater",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=REQUEST_TIMEOUT) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 429):
            hint = "Check GitHub token access and API rate limits."
        elif error.code == 404:
            hint = "Check repository access and the docker-publish.yml workflow."
        elif 300 <= error.code < 400:
            hint = "Redirects are refused; check the configured repository name."
        else:
            hint = "Try again when GitHub Actions is available."
        error.close()
        raise ReleaseError(f"GitHub release lookup failed (HTTP {error.code}). {hint}") from None
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        # Exception strings and response bodies can include tokens or proxy URLs.
        raise ReleaseError("GitHub release lookup could not connect securely within the timeout.") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise ReleaseError("GitHub release lookup returned an oversized response.")
    try:
        result = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ReleaseError("GitHub release lookup returned invalid JSON.") from None
    if not isinstance(result, dict) or not isinstance(result.get("workflow_runs"), list):
        raise ReleaseError("GitHub release lookup returned an unexpected workflow response.")
    return result["workflow_runs"]


def _repository_matches(value, expected):
    return (
        isinstance(value, dict)
        and isinstance(value.get("full_name"), str)
        and value["full_name"].casefold() == expected.casefold()
    )


def _candidate(run, repository, branch, source_sha):
    if not isinstance(run, dict):
        return None
    sha = run.get("head_sha")
    run_id = run.get("id")
    if not isinstance(sha, str) or not SHA_PATTERN.fullmatch(sha):
        return None
    sha = sha.lower()
    if (
        run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("event") not in ("push", "workflow_dispatch")
        or run.get("head_branch") != branch
        or not _repository_matches(run.get("repository"), repository)
        or not _repository_matches(run.get("head_repository"), repository)
        or type(run_id) is not int
        or run_id <= 0
        or (source_sha is not None and sha != source_sha)
    ):
        return None
    # GitHub may include a ref suffix in the documented run.path field.
    accepted_paths = {
        WORKFLOW_PATH,
        f"{WORKFLOW_PATH}@{branch}",
        f"{WORKFLOW_PATH}@refs/heads/{branch}",
        f"{WORKFLOW_PATH}@{sha}",
    }
    if not isinstance(run.get("path"), str) or run["path"] not in accepted_paths:
        return None
    try:
        created_at = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            return None
        created_at = created_at.astimezone(timezone.utc)
    except (KeyError, TypeError, AttributeError, ValueError):
        return None
    return created_at, run_id, sha


def resolve_release(component, channel="stable", source_sha=None, token=None):
    """Return the newest verified image build, or raise a sanitized ReleaseError.

    ``component`` is ``core`` or ``front``. ``stable`` follows ``main`` and
    ``stage`` follows ``stage`` (with a ``canary-<SHA>`` Docker tag).
    ``source_sha`` optionally selects an exact full
    commit SHA. At most five pages of 100 successful workflow runs are checked,
    with a ten-second network timeout per request. No local files are changed.
    """
    if not isinstance(component, str) or component not in REPOSITORIES:
        raise ReleaseError("Component must be core or front.")
    if not isinstance(channel, str) or channel not in CHANNEL_BRANCHES:
        raise ReleaseError("Channel must be stable or stage.")
    if source_sha is not None:
        if not isinstance(source_sha, str) or not SHA_PATTERN.fullmatch(source_sha):
            raise ReleaseError("Source SHA must be a full 40-character hexadecimal commit SHA.")
        source_sha = source_sha.lower()
    if token is not None:
        if (
            not isinstance(token, str)
            or not token.isascii()
            or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in token)
        ):
            raise ReleaseError("GitHub token must contain only ASCII characters without whitespace or controls.")

    repository = REPOSITORIES[component]
    branch = CHANNEL_BRANCHES[channel]
    candidates = []
    for page in range(1, MAX_PAGES + 1):
        query = {"branch": branch, "status": "success", "per_page": PAGE_SIZE, "page": page}
        if source_sha is not None:
            query["head_sha"] = source_sha
        url = (
            f"{API_ROOT}/repos/{repository}/actions/workflows/{WORKFLOW_FILE}/runs?"
            + urllib.parse.urlencode(query)
        )
        runs = _request_json(url, token)
        for run in runs:
            candidate = _candidate(run, repository, branch, source_sha)
            if candidate is not None:
                candidates.append(candidate)
        if len(runs) < PAGE_SIZE:
            break

    if not candidates:
        detail = f" at commit {source_sha}" if source_sha else ""
        raise ReleaseError(
            f"No successful {WORKFLOW_FILE} release found for {repository} on {branch}{detail} "
            f"within the first {MAX_PAGES * PAGE_SIZE} matching runs. "
            "Wait for the GitHub image build to complete successfully."
        )
    _, run_id, sha = max(candidates)
    return {
        "component": component,
        "sourceSha": sha,
        "imageTag": f"mikedim95/garsone-{component}:{CHANNEL_TAGS[channel]}-{sha}",
        "workflowRunId": run_id,
        "workflowUrl": f"https://github.com/{repository}/actions/runs/{run_id}",
        "repository": repository,
        "channel": channel,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=tuple(REPOSITORIES))
    parser.add_argument("--channel", choices=tuple(CHANNEL_BRANCHES), default="stable")
    parser.add_argument("--source-sha", help="Require this full Git commit SHA")
    args = parser.parse_args(argv)
    try:
        release = resolve_release(
            args.component,
            channel=args.channel,
            source_sha=args.source_sha,
            token=os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"),
        )
    except ReleaseError as error:
        print(f"Release lookup failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(release, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
