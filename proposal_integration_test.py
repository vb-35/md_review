#!/usr/bin/env python3
"""End-to-end tests for leased locks and pending revision proposals."""

import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
from models import get_db, init_db
from run import create_app


TMP_DIR = tempfile.mkdtemp(prefix='md_review_proposal_test_')
Config.DATABASE = os.path.join(TMP_DIR, 'test.db')
Config.SESSION_FILE_DIR = os.path.join(TMP_DIR, 'sessions')
Config.SECRET_KEY = 'proposal-test-secret'
Config.REPO_ROOT = os.path.join(TMP_DIR, 'storage')
Config.PROJECT_LOCK_TTL_SECONDS = 300
os.makedirs(Config.SESSION_FILE_DIR, exist_ok=True)
os.makedirs(Config.REPO_ROOT, exist_ok=True)
init_db().close()

app = create_app()
owner = app.test_client()
codex = app.test_client()
editor = app.test_client()


def login(client, username):
    response = client.post('/api/auth/login', json={'username': username})
    assert response.status_code == 200, response.data
    return response.get_json()['user']


def project_content(client, project_id, path):
    response = client.get(f'/api/projects/{project_id}/files/content?path={path}')
    assert response.status_code == 200, response.data
    return response.get_json()


def decide(client, project_id, proposal):
    items = []
    for file in proposal['files']:
        decision = 'accept' if file['filePath'] == 'docs/one.md' else 'refuse'
        items.extend({
            'kind': 'diff',
            'filePath': file['filePath'],
            'itemId': item['itemId'],
            'decision': decision,
        } for item in file['reviewItems'])
    items.extend({
        'kind': 'comment',
        'itemId': action['id'],
        'decision': 'accept',
    } for action in proposal['commentActions'])
    response = client.put(
        f"/api/projects/{project_id}/proposals/{proposal['id']}/decisions",
        json={'items': items},
    )
    assert response.status_code == 200, response.data
    return response.get_json()


try:
    owner_user = login(owner, 'owner')
    codex_user = login(codex, 'codex')
    login(editor, 'editor')

    response = owner.post('/api/projects', json={'title': 'Codex Review'})
    assert response.status_code == 201, response.data
    project = response.get_json()
    project_id = project['id']

    assert owner.post(f'/api/projects/{project_id}/lock').status_code == 200
    response = owner.post(
        f'/api/projects/{project_id}/files',
        json={'path': 'docs/one.md', 'content': '# One old\nkeep\n'},
    )
    assert response.status_code == 201, response.data
    response = owner.post(
        f'/api/projects/{project_id}/files',
        json={'path': 'docs/two.md', 'content': 'alpha\n'},
    )
    assert response.status_code == 201, response.data
    base_commit = response.get_json()['currentCommitSha']
    response = owner.put(f'/api/projects/{project_id}/files/content', json={
        'path': 'docs/one.md',
        'content': '# One\nkeep\n',
        'baseCommitSha': base_commit,
    })
    assert response.status_code == 200, response.data
    base_commit = response.get_json()['currentCommitSha']
    assert owner.delete(f'/api/projects/{project_id}/lock').status_code == 200
    response = owner.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'codex', 'role': 'editor'},
    )
    assert response.status_code == 200, response.data
    response = owner.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'editor', 'role': 'editor'},
    )
    assert response.status_code == 200, response.data

    response = codex.post(f'/api/projects/{project_id}/proposals', json={
        'title': 'Owner deletion test',
        'summary': '',
        'baseCommitSha': base_commit,
        'files': [{'path': 'docs/two.md', 'content': 'alpha\ntemporary owner deletion\n'}],
    })
    assert response.status_code == 201, response.data
    owner_delete_proposal = response.get_json()
    assert editor.delete(
        f"/api/projects/{project_id}/proposals/{owner_delete_proposal['id']}"
    ).status_code == 403
    decision_item = owner_delete_proposal['files'][0]['reviewItems'][0]
    response = owner.put(
        f"/api/projects/{project_id}/proposals/{owner_delete_proposal['id']}/decisions",
        json={'items': [{
            'kind': 'diff',
            'filePath': 'docs/two.md',
            'itemId': decision_item['itemId'],
            'decision': 'accept',
        }]},
    )
    assert response.status_code == 200, response.data
    response = owner.delete(
        f"/api/projects/{project_id}/proposals/{owner_delete_proposal['id']}"
    )
    assert response.status_code == 200, response.data
    assert response.get_json()['deleted'] is True
    assert owner.get(
        f"/api/projects/{project_id}/proposals/{owner_delete_proposal['id']}"
    ).status_code == 404
    with app.app_context():
        conn = get_db()
        assert conn.execute(
            'SELECT COUNT(*) FROM revision_proposal_files WHERE proposal_id = ?',
            (owner_delete_proposal['id'],),
        ).fetchone()[0] == 0
        assert conn.execute(
            'SELECT COUNT(*) FROM revision_proposal_decisions WHERE proposal_id = ?',
            (owner_delete_proposal['id'],),
        ).fetchone()[0] == 0
    assert project_content(owner, project_id, 'docs/two.md')['content'] == 'alpha\n'

    response = codex.post(f'/api/projects/{project_id}/proposals', json={
        'title': 'Author deletion test',
        'summary': '',
        'baseCommitSha': base_commit,
        'files': [{'path': 'docs/two.md', 'content': 'alpha\ntemporary author deletion\n'}],
    })
    assert response.status_code == 201, response.data
    author_delete_proposal = response.get_json()
    response = codex.delete(
        f"/api/projects/{project_id}/proposals/{author_delete_proposal['id']}"
    )
    assert response.status_code == 200, response.data
    assert all(
        item.get('proposalId') not in {owner_delete_proposal['id'], author_delete_proposal['id']}
        for item in owner.get(
            f'/api/projects/{project_id}/files/versions?path=docs/two.md'
        ).get_json()
    )
    print('PASS: unpublished_proposal_deletion_permissions_and_cascade')

    comment_context = {
        'projectId': project_id,
        'filePath': 'docs/one.md',
        'commitSha': base_commit,
    }
    response = owner.post('/api/comments/threads', json={**comment_context, 'body': 'Please clarify the title.'})
    assert response.status_code == 201, response.data
    thread_id = response.get_json()['id']

    proposal_payload = {
        'title': 'Clarify the introduction',
        'summary': 'Updates two files and responds to the open review thread.',
        'baseCommitSha': base_commit,
        'files': [
            {'path': 'docs/one.md', 'content': '# One clarified\nkeep\nnew accepted line\n'},
            {'path': 'docs/two.md', 'content': 'alpha\nrefused line\n'},
        ],
        'commentActions': [
            {
                'action': 'reply',
                'filePath': 'docs/one.md',
                'commitSha': base_commit,
                'threadId': thread_id,
                'body': 'Updated the title and added the requested context.',
            },
            {
                'action': 'resolve',
                'filePath': 'docs/one.md',
                'commitSha': base_commit,
                'threadId': thread_id,
            },
        ],
    }
    response = codex.post(f'/api/projects/{project_id}/proposals', json=proposal_payload)
    assert response.status_code == 201, response.data
    proposal = response.get_json()
    assert proposal['status'] == 'pending'
    assert proposal['review']['required'] > 0
    assert project_content(owner, project_id, 'docs/one.md')['content'] == '# One\nkeep\n'
    assert project_content(owner, project_id, 'docs/two.md')['content'] == 'alpha\n'
    assert owner.get(f'/api/projects/{project_id}').get_json()['lockOwnerId'] is None
    print('PASS: proposal_is_pending_and_releases_codex_lock')

    versions = owner.get(
        f'/api/projects/{project_id}/files/versions?path=docs/one.md'
    ).get_json()
    candidate = next(item for item in versions if item['kind'] == 'proposal')
    published_versions = [item for item in versions if item['kind'] == 'published']
    published_base = published_versions[0]
    older_version = published_versions[1]
    assert candidate['id'] == f"proposal:{proposal['id']}"
    assert candidate['proposalId'] == proposal['id']
    assert candidate['version'] is None
    assert candidate['author_id'] == codex_user['id']
    assert candidate['author_name'] == 'codex'
    assert candidate['baseVersionId'] == published_base['id']
    response = owner.get(
        f"/api/projects/{project_id}/files/versions/{candidate['id']}?path=docs/one.md"
    )
    assert response.status_code == 200, response.data
    assert response.get_json()['content'] == '# One clarified\nkeep\nnew accepted line\n'

    response = owner.post(f'/api/projects/{project_id}/files/compare', json={
        'path': 'docs/one.md',
        'versionA': published_base['id'],
        'versionB': candidate['id'],
    })
    assert response.status_code == 200, response.data
    comparison = response.get_json()
    assert comparison['proposalId'] == proposal['id']
    assert comparison['proposalAuthorUsername'] == 'codex'
    assert comparison['reviewerCanDecide'] is True
    assert comparison['labelB'] == 'Proposed by codex'
    assert comparison['proposalBaseMatches'] is True
    assert comparison['proposalDecisions'] == {}

    response = codex.post(f'/api/projects/{project_id}/files/compare', json={
        'path': 'docs/one.md',
        'versionA': published_base['id'],
        'versionB': candidate['id'],
    })
    assert response.status_code == 200, response.data
    assert response.get_json()['reviewerCanDecide'] is True

    response = owner.post(f'/api/projects/{project_id}/files/compare', json={
        'path': 'docs/one.md',
        'versionA': older_version['id'],
        'versionB': candidate['id'],
    })
    assert response.status_code == 200, response.data
    historical_comparison = response.get_json()
    assert historical_comparison['diff']
    assert historical_comparison['proposalBaseMatches'] is False
    assert historical_comparison['reviewerCanDecide'] is False
    assert historical_comparison['proposalDecisions'] == {}

    one_file = next(item for item in proposal['files'] if item['filePath'] == 'docs/one.md')
    first_review_item = one_file['reviewItems'][0]
    first_item_id = first_review_item['itemId']
    response = owner.put(
        f"/api/projects/{project_id}/proposals/{proposal['id']}/decisions",
        json={'items': [{
            'kind': 'diff',
            'filePath': 'docs/one.md',
            'itemId': first_item_id,
            'decision': 'accept',
        }]},
    )
    assert response.status_code == 200, response.data
    response = owner.post(f'/api/projects/{project_id}/files/compare', json={
        'path': 'docs/one.md',
        'versionA': published_base['id'],
        'versionB': candidate['id'],
    })
    assert response.status_code == 200, response.data
    assert response.get_json()['proposalDecisions'][first_item_id] == 'accept'
    assert project_content(owner, project_id, 'docs/one.md')['content'] == '# One\nkeep\n'
    assert owner.get(f'/api/projects/{project_id}').get_json()['lockOwnerId'] is None
    print('PASS: proposal_acts_as_reviewable_version_without_changing_live_file')

    response = codex.put(
        f"/api/projects/{project_id}/proposals/{proposal['id']}/decisions",
        json={'items': [{
            'kind': 'comment',
            'itemId': proposal['commentActions'][0]['id'],
            'decision': 'accept',
        }]},
    )
    assert response.status_code == 200, response.data
    print('PASS: proposal_author_can_review')

    proposal = decide(codex, project_id, proposal)
    assert proposal['review']['complete'] is True
    assert proposal['review']['canPublish'] is True
    response = codex.post(f"/api/projects/{project_id}/proposals/{proposal['id']}/publish")
    assert response.status_code == 200, response.data
    published = response.get_json()
    assert published['status'] == 'accepted'
    assert published['reviewerUsername'] == 'codex'
    response = owner.delete(f"/api/projects/{project_id}/proposals/{proposal['id']}")
    assert response.status_code == 409, response.data
    assert response.get_json()['code'] == 'accepted'
    assert published['appliedCommitSha'] != base_commit
    assert project_content(owner, project_id, 'docs/one.md')['content'] == '# One clarified\nkeep\nnew accepted line\n'
    assert project_content(owner, project_id, 'docs/two.md')['content'] == 'alpha\n'

    project_root = os.path.join(Config.REPO_ROOT, project['projectPath'])
    commit_count = subprocess.check_output(
        ['git', 'rev-list', '--count', f"{base_commit}..{published['appliedCommitSha']}"],
        cwd=project_root,
        text=True,
    ).strip()
    assert commit_count == '1'
    versions = owner.get(f'/api/projects/{project_id}/files/versions?path=docs/one.md').get_json()
    assert versions[0]['author_id'] == codex_user['id']
    assert versions[0]['author_name'] == 'codex'
    assert versions[0]['message'] == 'Accepted proposal: Clarify the introduction'
    two_versions = owner.get(f'/api/projects/{project_id}/files/versions?path=docs/two.md').get_json()
    assert len(two_versions) == 1
    threads = owner.get(
        f"/api/projects/{project_id}/threads?commitSha={published['appliedCommitSha']}&filePath=docs/one.md"
    ).get_json()
    thread = next(item for item in threads if item['id'] == thread_id)
    assert thread['resolved'] is True
    assert thread['resolvedBy'] == codex_user['id']
    assert any(comment.get('username') == 'codex' for comment in thread['comments'])
    assert owner.get(f'/api/projects/{project_id}').get_json()['lockOwnerId'] is None
    print('PASS: selective_publish_is_one_commit_with_codex_authorship')

    current_commit = published['appliedCommitSha']
    response = codex.post(f'/api/projects/{project_id}/proposals', json={
        'title': 'Will become stale',
        'summary': '',
        'baseCommitSha': current_commit,
        'files': [{'path': 'docs/two.md', 'content': 'alpha\nCodex candidate\n'}],
    })
    assert response.status_code == 201, response.data
    stale_proposal = response.get_json()
    assert owner.post(f'/api/projects/{project_id}/lock').status_code == 200
    response = owner.put(f'/api/projects/{project_id}/files/content', json={
        'path': 'docs/two.md',
        'content': 'alpha\nhuman edit\n',
        'baseCommitSha': current_commit,
    })
    assert response.status_code == 200, response.data
    assert owner.delete(f'/api/projects/{project_id}/lock').status_code == 200
    response = owner.get(f"/api/projects/{project_id}/proposals/{stale_proposal['id']}")
    assert response.status_code == 200, response.data
    assert response.get_json()['status'] == 'stale'
    assert owner.post(f"/api/projects/{project_id}/proposals/{stale_proposal['id']}/publish").status_code == 409
    versions = owner.get(
        f'/api/projects/{project_id}/files/versions?path=docs/two.md'
    ).get_json()
    assert all(item.get('proposalId') != stale_proposal['id'] for item in versions)
    print('PASS: head_change_marks_proposal_stale')

    latest_commit = project_content(owner, project_id, 'docs/two.md')['currentCommitSha']
    response = owner.post('/api/comments/threads', json={
        'projectId': project_id,
        'filePath': 'docs/two.md',
        'commitSha': latest_commit,
        'body': 'New thread',
    })
    assert response.status_code == 201, response.data
    changing_thread_id = response.get_json()['id']
    response = codex.post(f'/api/projects/{project_id}/proposals', json={
        'title': 'Comment-only proposal',
        'summary': '',
        'baseCommitSha': latest_commit,
        'commentActions': [{
            'action': 'reply',
            'filePath': 'docs/two.md',
            'commitSha': latest_commit,
            'threadId': changing_thread_id,
            'body': 'Draft answer',
        }],
    })
    assert response.status_code == 201, response.data
    comment_proposal = response.get_json()
    response = owner.post('/api/comment-lines', json={
        'projectId': project_id,
        'filePath': 'docs/two.md',
        'commitSha': latest_commit,
        'threadId': changing_thread_id,
        'body': 'Human changed the thread',
    })
    assert response.status_code == 201, response.data
    response = owner.get(f"/api/projects/{project_id}/proposals/{comment_proposal['id']}")
    assert response.status_code == 200, response.data
    assert response.get_json()['status'] == 'stale'
    assert 'comment thread changed' in response.get_json()['staleReason']
    print('PASS: comment_change_marks_proposal_stale')

    response = owner.post('/api/comments/threads', json={
        'projectId': project_id,
        'filePath': 'docs/two.md',
        'commitSha': latest_commit,
        'body': 'Rollback thread',
    })
    assert response.status_code == 201, response.data
    rollback_thread_id = response.get_json()['id']
    response = codex.post(f'/api/projects/{project_id}/proposals', json={
        'title': 'Rollback publication',
        'summary': '',
        'baseCommitSha': latest_commit,
        'files': [{'path': 'docs/two.md', 'content': 'alpha\nhuman edit\nrollback candidate\n'}],
        'commentActions': [{
            'action': 'reply',
            'filePath': 'docs/two.md',
            'commitSha': latest_commit,
            'threadId': rollback_thread_id,
            'body': 'This save is forced to fail once.',
        }],
    })
    assert response.status_code == 201, response.data
    rollback_proposal = response.get_json()
    rollback_items = [
        {
            'kind': 'diff',
            'filePath': file['filePath'],
            'itemId': item['itemId'],
            'decision': 'accept',
        }
        for file in rollback_proposal['files']
        for item in file['reviewItems']
    ] + [
        {
            'kind': 'comment',
            'itemId': action['id'],
            'decision': 'accept',
        }
        for action in rollback_proposal['commentActions']
    ]
    response = owner.put(
        f"/api/projects/{project_id}/proposals/{rollback_proposal['id']}/decisions",
        json={'items': rollback_items},
    )
    assert response.status_code == 200, response.data
    with patch('routes.proposals.save_comment_store', side_effect=RuntimeError('forced comment failure')):
        response = owner.post(f"/api/projects/{project_id}/proposals/{rollback_proposal['id']}/publish")
    assert response.status_code == 500, response.data
    rolled_back = project_content(owner, project_id, 'docs/two.md')
    assert rolled_back['content'] == 'alpha\nhuman edit\n'
    assert rolled_back['currentCommitSha'] == latest_commit
    response = owner.get(f"/api/projects/{project_id}/proposals/{rollback_proposal['id']}")
    assert response.get_json()['status'] == 'pending'
    assert owner.get(f'/api/projects/{project_id}').get_json()['lockOwnerId'] is None
    response = owner.post(f"/api/projects/{project_id}/proposals/{rollback_proposal['id']}/publish")
    assert response.status_code == 200, response.data
    assert response.get_json()['status'] == 'accepted'
    print('PASS: failed_publication_rolls_back_files_status_and_lock')

    assert codex.post(f'/api/projects/{project_id}/lock').status_code == 200
    with app.app_context():
        get_db().execute(
            'UPDATE projects SET lock_expires_at = ? WHERE id = ?',
            ('2000-01-01T00:00:00+00:00', project_id),
        )
        get_db().commit()
    listed_project = next(
        item for item in owner.get('/api/projects').get_json()
        if item['id'] == project_id
    )
    assert listed_project['lockOwnerId'] is None
    assert listed_project['lockExpiresAt'] is None
    response = owner.post(f'/api/projects/{project_id}/lock')
    assert response.status_code == 200, response.data
    assert response.get_json()['lockOwnerId'] == owner_user['id']
    heartbeat = owner.post(f'/api/projects/{project_id}/lock/heartbeat')
    assert heartbeat.status_code == 200, heartbeat.data
    assert datetime.fromisoformat(heartbeat.get_json()['lockExpiresAt']) > datetime.now(timezone.utc)
    assert owner.delete(f'/api/projects/{project_id}/lock').status_code == 200
    print('PASS: expired_lock_can_be_reclaimed_and_heartbeat_extends_lease')

    print('ALL PROPOSAL INTEGRATION TESTS PASSED')
finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)
