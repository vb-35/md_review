FROM python:3.13-slim

WORKDIR /app

COPY server/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY server/ /app/server/
COPY webapp/ /app/webapp/

RUN mkdir -p /data/flask_session

EXPOSE 8000

WORKDIR /app/server

CMD ["gunicorn", "run:create_app", "-b", "0.0.0.0:8000", "--threads", "4", "--workers", "2", "--access-logfile", "-"]
