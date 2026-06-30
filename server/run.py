from flask import Flask, redirect, send_from_directory
from flask_cors import CORS
from flask_session import Session
from models import init_db, close_db
from config import Config
import os

def normalize_base_path(raw_path):
    if not raw_path:
        return ''
    path = raw_path.strip()
    if path == '/':
        return ''
    if not path.startswith('/'):
        path = f'/{path}'
    return path.rstrip('/')

def create_app():
    base_path = normalize_base_path(Config.APP_BASE_PATH)
    app = Flask(
        __name__,
        static_folder=os.path.join(os.path.dirname(__file__), '..', 'webapp'),
        static_url_path=base_path or ''
    )
    app.config.from_object(Config)
    app.config['APP_BASE_PATH'] = base_path
    os.makedirs(app.config['SESSION_FILE_DIR'], exist_ok=True)
    app.teardown_appcontext(close_db)

    CORS(app, supports_credentials=True)
    Session(app)

    from routes.auth import auth_bp
    from routes.documents import doc_bp
    from routes.review import review_bp
    api_prefix = f'{base_path}/api'
    app.register_blueprint(auth_bp, url_prefix=f'{api_prefix}/auth')
    app.register_blueprint(doc_bp, url_prefix=api_prefix)
    app.register_blueprint(review_bp, url_prefix=api_prefix)

    @app.route(f'{base_path}/')
    def index():
        webapp_dir = os.path.join(os.path.dirname(__file__), '..', 'webapp')
        return send_from_directory(webapp_dir, 'index.html')

    if base_path:
        @app.route('/')
        def root():
            return redirect(f'{base_path}/', code=308)

        @app.route(base_path)
        def base_redirect():
            return redirect(f'{base_path}/', code=308)

    init_db().close()
    return app

if __name__ == '__main__':
    run_host = os.environ.get('FLASK_HOST', '0.0.0.0')
    run_port = int(os.environ.get('FLASK_PORT', '5000'))
    run_debug = os.environ.get('FLASK_DEBUG', 'off') in ('on', '1', 'true')
    app = create_app()
    app.run(debug=run_debug, host=run_host, port=run_port)
