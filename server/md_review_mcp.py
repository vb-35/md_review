#!/usr/bin/env python3
"""Local stdio MCP adapter for the md_review HTTP API.

This process deliberately has no direct project-storage access. Every operation is
performed through the same HTTP API used by the browser so permissions, proposal
snapshots, authorship, comments, and project locks remain authoritative.
"""

import json
import os
from http.cookiejar import CookieJar
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener

from mcp.server.fastmcp import FastMCP


class MdReviewApi:
    def __init__(self, base_url: str, username: str):
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        self.logged_in = False

    def request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
        if not self.logged_in and path != '/auth/login':
            self.login()
        url = f"{self.base_url}/api{path}"
        data = json.dumps(body).encode('utf-8') if body is not None else None
        request = Request(
            url,
            data=data,
            method=method,
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read().decode('utf-8')
                return json.loads(raw) if raw else None
        except HTTPError as exc:
            raw = exc.read().decode('utf-8', errors='replace')
            try:
                detail = json.loads(raw).get('error', raw)
            except json.JSONDecodeError:
                detail = raw
            raise RuntimeError(f"md_review API {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Cannot reach md_review at {self.base_url}: {exc.reason}") from exc

    def login(self) -> Dict[str, Any]:
        payload = self.request('POST', '/auth/login', {'username': self.username})
        self.logged_in = True
        return payload['user']


api = MdReviewApi(
    os.environ.get('MD_REVIEW_URL', 'http://127.0.0.1:18080'),
    os.environ.get('MD_REVIEW_USERNAME', 'codex'),
)

mcp = FastMCP(
    'MD Review',
    instructions=(
        'Work only through these tools. Read the current project and comments before editing. '
        'Submit edits as a pending revision proposal based on the exact currentCommitSha. '
        'Never claim proposed work is saved or its review is closed; an editor must review, save, and close it.'
    ),
    json_response=True,
)


@mcp.tool()
def list_projects() -> List[Dict[str, Any]]:
    """List projects shared with the configured Codex user."""
    return api.request('GET', '/projects')


@mcp.tool()
def get_project_context(project_id: str) -> Dict[str, Any]:
    """Read project metadata, current commit, file tree, and existing proposals."""
    project = api.request('GET', f'/projects/{project_id}')
    files = api.request('GET', f'/projects/{project_id}/files')
    proposals = api.request('GET', f'/projects/{project_id}/proposals')
    return {'project': project, 'files': files['items'], 'proposals': proposals}


@mcp.tool()
def read_markdown(project_id: str, file_path: str) -> Dict[str, Any]:
    """Read one current Markdown file and its current project commit SHA."""
    query = urlencode({'path': file_path})
    return api.request('GET', f'/projects/{project_id}/files/content?{query}')


@mcp.tool()
def list_file_versions(project_id: str, file_path: str) -> List[Dict[str, Any]]:
    """List published versions and pending proposed versions with authorship."""
    query = urlencode({'path': file_path})
    return api.request('GET', f'/projects/{project_id}/files/versions?{query}')


@mcp.tool()
def read_file_version(
    project_id: str,
    version_id: str,
    file_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Read one published or proposed file version.

    file_path is required when version_id starts with ``proposal:`` because one
    proposal can contain candidate versions for multiple files.
    """
    query = f'?{urlencode({"path": file_path})}' if file_path else ''
    return api.request('GET', f'/projects/{project_id}/files/versions/{version_id}{query}')


@mcp.tool()
def list_comment_threads(
    project_id: str,
    file_path: str,
    commit_sha: str,
    include_resolved: bool = False,
) -> List[Dict[str, Any]]:
    """Read comment threads applicable to a file at a specific commit."""
    query = urlencode({'filePath': file_path, 'commitSha': commit_sha})
    threads = api.request('GET', f'/projects/{project_id}/threads?{query}')
    return threads if include_resolved else [item for item in threads if not item.get('resolved')]


@mcp.tool()
def list_revision_proposals(project_id: str) -> List[Dict[str, Any]]:
    """List pending, accepted, rejected, and stale revision proposals."""
    return api.request('GET', f'/projects/{project_id}/proposals')


@mcp.tool()
def get_revision_proposal(project_id: str, proposal_id: str) -> Dict[str, Any]:
    """Read one proposal, its diff review items, decisions, and publication status."""
    return api.request('GET', f'/projects/{project_id}/proposals/{proposal_id}')


@mcp.tool()
def submit_revision_proposal(
    project_id: str,
    base_commit_sha: str,
    title: str,
    summary: str,
    file_changes: List[Dict[str, str]],
    comment_actions: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Submit a pending proposal; this never changes live files.

    file_changes entries require ``path`` and full replacement ``content`` for an
    existing Markdown file. comment_actions entries require ``action`` (reply or
    resolve), ``filePath``, ``threadId``, and optionally ``commitSha``; replies also
    require ``body``. Use the exact current project commit as base_commit_sha.
    """
    return api.request('POST', f'/projects/{project_id}/proposals', {
        'baseCommitSha': base_commit_sha,
        'title': title,
        'summary': summary,
        'files': file_changes,
        'commentActions': comment_actions or [],
    })


if __name__ == '__main__':
    mcp.run(transport='stdio')
