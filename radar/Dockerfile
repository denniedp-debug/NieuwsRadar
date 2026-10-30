# Build-context is de hoofdmap van de repo (zie .github/workflows/docker.yml)
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY radar/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY radar/app ./app
COPY config.yaml ./config.yaml
EXPOSE 8080
VOLUME ["/data"]
# --proxy-headers: achter je reverse proxy (https) worden cookies dan als "Secure" gezet
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
