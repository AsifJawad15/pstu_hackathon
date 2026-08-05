FROM python:3.13-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

RUN groupadd --system optimizer && useradd --system --gid optimizer --home-dir /app optimizer
COPY aegis/src/aegis ./aegis
COPY aegis/tests ./aegis-tests
COPY services/optimizer/optimizer ./optimizer
COPY services/optimizer/tests ./tests
RUN chown -R optimizer:optimizer /app

USER optimizer
EXPOSE 8090
CMD ["python", "-m", "optimizer.server"]
