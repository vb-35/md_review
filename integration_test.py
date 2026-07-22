#!/usr/bin/env python3
"""Quick integration test."""
import os
import shutil
import subprocess
import sys
import tarfile
from concurrent.futures import ThreadPoolExecutor
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
from models import get_db, init_db
from run import create_app


TMP_DIR = tempfile.mkdtemp(prefix='md_review_test_')
Config.DATABASE = os.path.join(TMP_DIR, 'test.db')
Config.SESSION_FILE_DIR = os.path.join(TMP_DIR, 'sessions')
Config.SECRET_KEY = 'test-secret'
Config.REPO_ROOT = os.path.join(TMP_DIR, 'storage')
os.makedirs(Config.SESSION_FILE_DIR, exist_ok=True)
os.makedirs(Config.REPO_ROOT, exist_ok=True)
init_db().close()

app = create_app()
client = app.test_client()
viewer_client = app.test_client()
editor_client = app.test_client()
admin_client = app.test_client()
managed_client = app.test_client()
other_client = app.test_client()


def cleanup():
    shutil.rmtree(TMP_DIR, ignore_errors=True)


def login(test_client, username):
    response = test_client.post('/api/auth/login', json={'username': username})
    assert response.status_code == 200, response.data


try:
    login(client, 'owner')
    login(viewer_client, 'viewer')
    login(editor_client, 'editor')
    login(admin_client, 'admin')
    login(managed_client, 'managed')
    login(other_client, 'other')
    print("PASS: login")

    response = client.post('/api/projects', json={'title': 'Specs'})
    assert response.status_code == 201, response.data
    project = response.get_json()
    project_id = project['id']
    assert project['currentCommitSha'] is None
    print("PASS: create_project")

    response = client.post('/api/projects', json={'title': 'Unsafe', 'projectPath': '.'})
    assert response.status_code == 400, response.data
    print("PASS: client_project_path_rejected")

    response = client.post(f'/api/projects/{project_id}/lock')
    assert response.status_code == 200, response.data
    print("PASS: owner_lock")

    response = client.post(f'/api/projects/{project_id}/files', json={'path': 'docs/spec.md', 'content': '# Start\n'})
    assert response.status_code == 201, response.data
    first_commit = response.get_json()['currentCommitSha']
    assert first_commit
    print("PASS: create_markdown_file")

    response = client.get(f'/api/projects/{project_id}/files/content?path=docs/spec.md')
    assert response.status_code == 200
    assert response.get_json()['content'] == '# Start\n'
    print("PASS: get_file_content")

    response = client.post(f'/api/projects/{project_id}/shares', json={'username': 'viewer', 'role': 'viewer'})
    assert response.status_code == 200
    response = client.post(f'/api/projects/{project_id}/shares', json={'username': 'editor', 'role': 'editor'})
    assert response.status_code == 200
    response = client.post(f'/api/projects/{project_id}/shares', json={'username': 'admin', 'role': 'admin'})
    assert response.status_code == 200
    admin_share = response.get_json()
    assert client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'managed', 'role': 'owner'},
    ).status_code == 400
    assert client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'managed', 'role': 'unknown'},
    ).status_code == 400
    print("PASS: share_project")

    historic_context = {
        'projectId': project_id,
        'filePath': 'docs/spec.md',
        'commitSha': first_commit,
    }
    response = viewer_client.post(
        '/api/comments/threads',
        json={**historic_context, 'body': 'Comment from version one'},
    )
    assert response.status_code == 201, response.data
    historic_thread_id = response.get_json()['id']

    response = admin_client.get('/api/projects')
    assert response.status_code == 200
    assert any(item['id'] == project_id and item['accessRole'] == 'admin' for item in response.get_json())
    response = admin_client.get(f'/api/projects/{project_id}/shares')
    assert response.status_code == 200
    assert {share['role'] for share in response.get_json()} == {'admin', 'editor', 'viewer'}
    response = admin_client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'managed', 'role': 'editor'},
    )
    assert response.status_code == 200
    managed_share = response.get_json()
    response = admin_client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'managed', 'role': 'viewer'},
    )
    assert response.status_code == 200
    assert response.get_json()['role'] == 'viewer'
    assert admin_client.delete(
        f"/api/projects/{project_id}/shares/{managed_share['userId']}"
    ).status_code == 200
    assert admin_client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'owner', 'role': 'viewer'},
    ).status_code == 400
    assert admin_client.delete(f'/api/projects/{project_id}').status_code == 403
    print("PASS: admin_manages_shares_but_cannot_delete_project")

    response = editor_client.get(f'/api/projects/{project_id}/shares')
    assert response.status_code == 403
    assert editor_client.post(
        f'/api/projects/{project_id}/shares',
        json={'username': 'managed', 'role': 'viewer'},
    ).status_code == 403
    assert editor_client.delete(
        f"/api/projects/{project_id}/shares/{admin_share['userId']}"
    ).status_code == 403
    print("PASS: editor_cannot_view_or_manage_shares")

    response = viewer_client.get('/api/projects')
    assert response.status_code == 200
    assert any(item['id'] == project_id and item['accessRole'] == 'viewer' for item in response.get_json())
    print("PASS: viewer_list_projects")

    response = viewer_client.put(f'/api/projects/{project_id}/files/content', json={'path': 'docs/spec.md', 'content': '# No\n'})
    assert response.status_code == 403
    print("PASS: viewer_cannot_edit")

    response = client.delete(f'/api/projects/{project_id}/lock')
    assert response.status_code == 200, response.data
    print("PASS: owner_unlock")

    response = editor_client.post(f'/api/projects/{project_id}/lock')
    assert response.status_code == 200
    print("PASS: editor_lock")

    response = editor_client.post(
        f'/api/comments/threads/{historic_thread_id}/resolve',
        json=historic_context,
    )
    assert response.status_code == 200 and response.get_json()['resolved'] is True

    response = client.post(f'/api/projects/{project_id}/lock')
    assert response.status_code == 423, response.data
    response = editor_client.delete(f'/api/projects/{project_id}/files', json={'path': '.'})
    assert response.status_code == 403, response.data
    response = editor_client.delete(f'/api/projects/{project_id}/files', json={'path': '.git'})
    assert response.status_code == 403, response.data
    assert os.path.exists(os.path.join(Config.REPO_ROOT, project['projectPath'], 'docs', 'spec.md'))
    print("PASS: atomic_lock_and_root_deletion_blocked")

    response = editor_client.put(f'/api/projects/{project_id}/files/content', json={'path': 'docs/spec.md', 'content': '# Updated\n', 'baseCommitSha': first_commit})
    assert response.status_code == 200, response.data
    second_commit = response.get_json()['currentCommitSha']
    assert second_commit and second_commit != first_commit
    print("PASS: editor_save")
    response = editor_client.put(f'/api/projects/{project_id}/files/content', json={
        'path': 'docs/spec.md',
        'content': '# Stale overwrite\n',
        'baseCommitSha': first_commit,
    })
    assert response.status_code == 409, response.data
    print("PASS: stale_save_rejected")


    response = editor_client.get(f'/api/projects/{project_id}/files/versions?path=docs/spec.md')
    assert response.status_code == 200
    versions = response.get_json()
    assert len(versions) == 2
    assert all('content' not in version and 'diff' not in version for version in versions)
    with app.app_context():
        stored_diff_count = get_db().execute(
            "SELECT COUNT(*) FROM file_versions WHERE project_id = ? AND diff IS NOT NULL", (project_id,)
        ).fetchone()[0]
    assert stored_diff_count == 0
    print("PASS: list_versions")

    response = editor_client.post(f'/api/projects/{project_id}/files/compare', json={
        'path': 'docs/spec.md',
        'versionA': versions[1]['id'],
        'versionB': versions[0]['id'],
    })
    assert response.status_code == 200
    diff = response.get_json()['diff']
    assert any(row['type'] in ('added', 'removed') for row in diff)
    compare_payload = response.get_json()
    print("PASS: compare_versions")

    changed_row = next(row for row in diff if row['type'] in ('added', 'removed') and row.get('chunks'))
    changed_chunk = changed_row['chunks'][0]

    response = viewer_client.post(f'/api/projects/{project_id}/files/apply-diff-chunk', json={
        'path': 'docs/spec.md',
        'versionA': versions[1]['id'],
        'versionB': versions[0]['id'],
        'currentContent': '# Updated\n',
        'rowId': changed_row['rowId'],
        'chunkId': changed_chunk['chunkId'],
        'decision': 'refuse',
    })
    assert response.status_code == 403
    print("PASS: viewer_cannot_apply_diff_chunk")

    response = editor_client.post(f'/api/projects/{project_id}/files/apply-diff-chunk', json={
        'path': 'docs/spec.md',
        'versionA': compare_payload['versionAId'],
        'versionB': compare_payload['versionBId'],
        'currentContent': '# Updated\n',
        'rowId': changed_row['rowId'],
        'chunkId': changed_chunk['chunkId'],
        'decision': 'refuse',
        'decisions': [{
            'rowId': changed_row['rowId'],
            'chunkId': changed_chunk['chunkId'],
            'decision': 'refuse',
        }],
    })
    assert response.status_code == 200, response.data
    applied_content = response.get_json()['content']
    assert applied_content == '# Start\n'

    response = editor_client.put(f'/api/projects/{project_id}/files/content', json={
        'path': 'docs/spec.md',
        'content': applied_content,
        'baseCommitSha': second_commit,
    })
    assert response.status_code == 200, response.data
    print("PASS: apply_diff_chunk_and_save")

    context = {
        'projectId': project_id,
        'filePath': 'docs/spec.md',
        'commitSha': second_commit,
    }
    response = viewer_client.post('/api/comments/threads', json={**context, 'body': 'Looks good'})
    assert response.status_code == 201, response.data
    thread_id = response.get_json()['id']
    response = viewer_client.post('/api/comment-lines', json={**context, 'threadId': thread_id, 'body': 'Nit: title'})
    assert response.status_code == 201
    reply_id = response.get_json()['id']
    response = viewer_client.get(f"/api/projects/{project_id}/threads?commitSha={second_commit}&filePath=docs/spec.md")
    assert response.status_code == 200
    assert any(thread['id'] == thread_id for thread in response.get_json())
    print("PASS: comment_thread")

    malicious_context = {**context, 'commitSha': '../../../../../../escaped'}
    response = viewer_client.post('/api/comments/threads', json={**malicious_context, 'body': 'escape'})
    assert response.status_code == 400, response.data
    assert not os.path.exists(os.path.join(Config.REPO_ROOT, 'escaped.json'))
    print("PASS: comment_commit_traversal_blocked")

    def add_concurrent_reply(index):
        local_client = app.test_client()
        login(local_client, 'viewer')
        reply = local_client.post('/api/comment-lines', json={**context, 'threadId': thread_id, 'body': f'Reply {index}'})
        return reply.status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(add_concurrent_reply, range(8)))
    assert statuses == [201] * 8, statuses
    response = viewer_client.get(f"/api/projects/{project_id}/threads?commitSha={second_commit}&filePath=docs/spec.md")
    assert response.status_code == 200
    saved_thread = next(thread for thread in response.get_json() if thread['id'] == thread_id)
    assert len(saved_thread['comments']) == 10
    print("PASS: concurrent_comment_updates_preserved")

    root_comment_id = saved_thread['comments'][0]['id']
    expected_remaining_ids = [
        comment['id'] for comment in saved_thread['comments'] if comment['id'] != reply_id
    ]
    response = viewer_client.delete(
        f'/api/comments/threads/{thread_id}/comments/{reply_id}',
        json=context,
    )
    assert response.status_code == 403
    response = admin_client.delete(
        f'/api/comments/threads/{thread_id}/comments/{reply_id}',
        json=context,
    )
    assert response.status_code == 403
    response = client.delete(
        f'/api/comments/threads/{thread_id}/comments/{root_comment_id}',
        json=context,
    )
    assert response.status_code == 400
    response = client.delete(
        f'/api/comments/threads/{thread_id}/comments/{reply_id}',
        json=context,
    )
    assert response.status_code == 200, response.data
    response = viewer_client.get(
        f'/api/projects/{project_id}/threads?commitSha={second_commit}&filePath=docs/spec.md'
    )
    saved_thread = next(thread for thread in response.get_json() if thread['id'] == thread_id)
    assert len(saved_thread['comments']) == 9
    assert [comment['id'] for comment in saved_thread['comments']] == expected_remaining_ids
    print("PASS: owner_deletes_comment_reply")

    response = viewer_client.post(f'/api/comments/threads/{thread_id}/resolve', json=context)
    assert response.status_code == 403
    response = editor_client.post(f'/api/comments/threads/{thread_id}/resolve', json=context)
    assert response.status_code == 200
    print("PASS: resolve_thread")

    with open(os.path.join(TMP_DIR, 'logo.svg'), 'wb') as handle:
        handle.write(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    with open(os.path.join(TMP_DIR, 'logo.svg'), 'rb') as handle:
        response = editor_client.post(
            f'/api/projects/{project_id}/assets',
            data={'path': 'assets', 'file': (handle, 'logo.svg')},
            content_type='multipart/form-data'
        )
    assert response.status_code == 201, response.data
    uploaded = response.get_json()
    assert uploaded['path'] == 'assets/logo.svg'
    print("PASS: upload_asset")

    response = editor_client.post(f'/api/projects/{project_id}/rename', json={
        'oldPath': 'docs/spec.md',
        'newPath': 'docs/final.md',
    })
    assert response.status_code == 200
    rename_commit = response.get_json()['currentCommitSha']
    response = editor_client.get(f'/api/projects/{project_id}/files/content?path=docs/final.md')
    assert response.status_code == 200
    assert response.get_json()['content'] == '# Start\n'
    response = viewer_client.get(
        f'/api/projects/{project_id}/threads',
        query_string={'commitSha': rename_commit, 'filePath': 'docs/final.md'},
    )
    renamed_thread = next(thread for thread in response.get_json() if thread['id'] == thread_id)
    assert renamed_thread['filePath'] == 'docs/final.md' and len(renamed_thread['comments']) == 9
    print("PASS: rename_markdown_file")

    response = editor_client.delete(f'/api/projects/{project_id}/files', json={'path': 'assets/logo.svg'})
    assert response.status_code == 403
    assert os.path.exists(os.path.join(Config.REPO_ROOT, project['projectPath'], 'assets', 'logo.svg'))
    print("PASS: editor_cannot_delete_asset")

    response = editor_client.post(f'/api/projects/{project_id}/files/versions/{versions[1]["id"]}/rollback')
    assert response.status_code == 200, response.data
    rollback = response.get_json()
    assert rollback['rolledBackToVersion'] == 1
    assert rollback['deletedVersions'] == 2
    assert rollback['restoredThreads'] == 1
    response = editor_client.get(f'/api/projects/{project_id}/files/content?path=docs/final.md')
    assert response.status_code == 200
    assert response.get_json()['content'] == '# Start\n'
    response = editor_client.get(f'/api/projects/{project_id}/files/versions?path=docs/final.md')
    assert response.status_code == 200
    remaining_versions = [item for item in response.get_json() if item['kind'] == 'published']
    assert [item['version'] for item in remaining_versions] == [1]
    response = viewer_client.get(
        f'/api/projects/{project_id}/threads',
        query_string={'commitSha': rollback['currentCommitSha'], 'filePath': 'docs/final.md'},
    )
    restored_threads = response.get_json()
    assert [thread['id'] for thread in restored_threads] == [historic_thread_id]
    assert restored_threads[0]['resolved'] is False
    assert restored_threads[0]['resolvedBy'] is None
    assert restored_threads[0]['resolvedAt'] is None
    print("PASS: rollback_version_restores_unresolved_comments")

    assert editor_client.delete(f'/api/projects/{project_id}/lock').status_code == 200
    assert admin_client.post(f'/api/projects/{project_id}/lock').status_code == 200
    response = admin_client.post(
        f'/api/projects/{project_id}/files',
        json={'path': 'admin/tmp.md', 'content': '# Admin\n'},
    )
    assert response.status_code == 201, response.data
    response = admin_client.delete(f'/api/projects/{project_id}/files', json={'path': 'admin'})
    assert response.status_code == 200, response.data
    response = admin_client.delete(
        f'/api/projects/{project_id}/files', json={'path': 'assets/logo.svg'}
    )
    assert response.status_code == 200, response.data
    print("PASS: admin_edits_and_deletes_files_folders_and_assets")

    response = other_client.get(f'/api/projects/{project_id}')
    assert response.status_code == 404
    print("PASS: outsider_blocked")

    response = viewer_client.get(f'/api/projects/{project_id}/download')
    assert response.status_code == 200, response.data
    assert response.headers['Content-Disposition'].endswith('.tar.gz')
    bundle_path = os.path.join(TMP_DIR, 'project.tar.gz')
    with open(bundle_path, 'wb') as handle:
        handle.write(response.data)
    extract_dir = os.path.join(TMP_DIR, 'downloaded')
    os.makedirs(extract_dir, exist_ok=True)
    with tarfile.open(bundle_path, 'r:gz') as archive:
        archive.extractall(extract_dir)
        members = archive.getnames()
    repo_root = os.path.join(extract_dir, members[0].split('/')[0])
    assert os.path.exists(os.path.join(repo_root, '.git', 'HEAD'))
    commit_count = subprocess.run(
        ['git', '-C', repo_root, 'rev-list', '--count', 'HEAD'],
        check=True,
        text=True,
        stdout=subprocess.PIPE
    ).stdout.strip()
    assert commit_count == '8'
    with open(os.path.join(repo_root, 'docs', 'final.md'), 'r', encoding='utf-8') as handle:
        assert handle.read() == '# Start\n'
    print("PASS: download_project_repo")

    response = other_client.get(f'/api/projects/{project_id}/download')
    assert response.status_code == 404
    print("PASS: outsider_download_blocked")

    assert admin_client.delete(f'/api/projects/{project_id}/lock').status_code == 200
    assert admin_client.delete(
        f"/api/projects/{project_id}/shares/{admin_share['userId']}"
    ).status_code == 200
    assert admin_client.get(f'/api/projects/{project_id}').status_code == 404
    print("PASS: admin_can_remove_own_access")

    response = client.delete(f'/api/projects/{project_id}')
    assert response.status_code == 200
    print("PASS: delete_project")

    with app.app_context():
        count = get_db().execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        assert count == 0
    print("PASS: project_deleted_from_db")

finally:
    cleanup()
