import { type Knobs, lines, type RepoContext, type UpstreamInfo } from './context';

type Files = Record<string, string>;

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function pyproject(ctx: RepoContext, k: Knobs): string {
  return lines(
    '[build-system]',
    'requires = ["setuptools>=69", "wheel"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    `name = "${ctx.repo.name}"`,
    `version = "${k.version}"`,
    `description = "${ctx.repo.description.replace(/"/g, "'")}"`,
    'requires-python = ">=3.12"',
    'dependencies = [',
    `    "fastapi==${k.deps.fastapi}",`,
    `    "uvicorn[standard]==${k.deps.uvicorn}",`,
    `    "httpx==${k.deps.httpx}",`,
    `    "pydantic-settings==${k.deps['pydantic-settings']}",`,
    `    "structlog==${k.deps.structlog}",`,
    k.cacheTtlSec > 0 && '    "cachetools==5.5.0",',
    ']',
    '',
    '[project.optional-dependencies]',
    'dev = [',
    `    "pytest==${k.deps.pytest}",`,
    '    "pytest-asyncio==0.24.0",',
    '    "pytest-cov==5.0.0",',
    '    "respx==0.22.0",',
    ']',
    '',
    '[tool.setuptools.packages.find]',
    'where = ["src"]',
    '',
    '[tool.pytest.ini_options]',
    'asyncio_mode = "auto"',
    'testpaths = ["tests"]',
    'pythonpath = ["src"]',
    '',
  );
}

function configPy(ctx: RepoContext, k: Knobs): string {
  return lines(
    '"""Runtime settings. Every field can be overridden with an environment variable."""',
    '',
    'from pydantic import BaseModel',
    'from pydantic_settings import BaseSettings, SettingsConfigDict',
    '',
    '',
    'class Upstream(BaseModel):',
    '    base_url: str',
    '    connect_timeout_s: float',
    '    read_timeout_s: float',
    '    retries: int',
    '',
    '',
    'class Settings(BaseSettings):',
    '    model_config = SettingsConfigDict(env_nested_delimiter="__")',
    '',
    `    service_name: str = "${ctx.repo.name}"`,
    `    log_level: str = "${k.logLevel}"`,
    `    max_page_size: int = ${k.maxPageSize}`,
    `    cache_ttl_seconds: int = ${k.cacheTtlSec}`,
    `    max_connections: int = ${k.poolSize}`,
    ...ctx.upstreams.flatMap((u) => {
      const t = k.timeouts[u.tla]!;
      return [
        `    ${u.lower}: Upstream = Upstream(`,
        `        base_url="${u.baseUrl}",`,
        `        connect_timeout_s=${(t.connectMs / 1000).toFixed(2)},`,
        `        read_timeout_s=${(t.readMs / 1000).toFixed(1)},`,
        `        retries=${t.retries},`,
        '    )',
      ];
    }),
    '',
    '',
    'settings = Settings()',
    '',
  );
}

function clientPy(ctx: RepoContext, k: Knobs, u: UpstreamInfo): string {
  const op = u.op;
  const fn = snake(op.method);
  const arg = snake(op.arg);
  const get = op.verb === 'GET';
  const path = op.path.replace('{id}', `{${arg}}`);
  return lines(
    `"""Client for ${u.appName} (${u.tla}), service \`${u.service}\`."""`,
    '',
    'import httpx',
    'import structlog',
    '',
    `from ${ctx.pyPackage}.config import settings`,
    k.features.requestIdHeader && `from ${ctx.pyPackage}.context import request_id`,
    '',
    'log = structlog.get_logger(__name__)',
    '',
    `_cfg = settings.${u.lower}`,
    '_client = httpx.AsyncClient(',
    '    base_url=_cfg.base_url,',
    '    timeout=httpx.Timeout(_cfg.read_timeout_s, connect=_cfg.connect_timeout_s),',
    '    limits=httpx.Limits(max_connections=settings.max_connections),',
    k.features.retryOnTimeout && '    transport=httpx.AsyncHTTPTransport(retries=_cfg.retries),',
    ')',
    '',
    '',
    get ? `async def ${fn}(${arg}: str) -> dict:` : `async def ${fn}(${arg}: dict) -> dict:`,
    `    """${op.summary}."""`,
    k.features.requestIdHeader && '    headers = {"x-request-id": request_id.get()}',
    get
      ? `    response = await _client.get(f"${path}"${k.features.requestIdHeader ? ', headers=headers' : ''})`
      : `    response = await _client.post("${op.path}", json=${arg}${k.features.requestIdHeader ? ', headers=headers' : ''})`,
    '    if response.status_code >= 500:',
    `        log.warning("upstream_error", upstream="${u.tla}", status=response.status_code)`,
    '    response.raise_for_status()',
    '    return response.json()',
    '',
  );
}

function servicePy(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  const ups = ctx.upstreams;
  return lines(
    `"""${r.title} domain logic."""`,
    '',
    'import uuid',
    'from datetime import UTC, datetime',
    '',
    k.cacheTtlSec > 0 && 'from cachetools import TTLCache',
    ...ups.map((u) => `from ${ctx.pyPackage}.clients import ${u.lower}`),
    k.cacheTtlSec > 0 && `from ${ctx.pyPackage}.config import settings`,
    `from ${ctx.pyPackage}.models import ${r.pascal}, Create${r.pascal}`,
    '',
    `_store: dict[str, ${r.pascal}] = {}`,
    k.cacheTtlSec > 0 &&
      `_cache: TTLCache[str, ${r.pascal}] = TTLCache(maxsize=10_000, ttl=settings.cache_ttl_seconds)`,
    '',
    '',
    `def get_${r.snake}(${r.snake}_id: str) -> ${r.pascal} | None:`,
    k.cacheTtlSec > 0 && `    if ${r.snake}_id in _cache:`,
    k.cacheTtlSec > 0 && `        return _cache[${r.snake}_id]`,
    `    found = _store.get(${r.snake}_id)`,
    k.cacheTtlSec > 0 && '    if found is not None:',
    k.cacheTtlSec > 0 && `        _cache[${r.snake}_id] = found`,
    '    return found',
    '',
    '',
    `def list_${r.snake}s(page: int, size: int) -> list[${r.pascal}]:`,
    '    return list(_store.values())[page * size : (page + 1) * size]',
    '',
    '',
    `async def create_${r.snake}(data: Create${r.pascal}) -> ${r.pascal}:`,
    ...ups.map((u) =>
      u.op.verb === 'GET'
        ? `    await ${u.lower}.${snake(u.op.method)}(data.${snake(u.op.arg)})`
        : `    await ${u.lower}.${snake(u.op.method)}({"reference": data.reference, "source": "${ctx.repo.name}"})`,
    ),
    `    created = ${r.pascal}(`,
    '        id=str(uuid.uuid4()),',
    '        reference=data.reference,',
    '        status="ACCEPTED",',
    ctx.amountField && '        amount=data.amount,',
    '        created_at=datetime.now(UTC),',
    '    )',
    '    _store[created.id] = created',
    '    return created',
    '',
  );
}

function modelsPy(ctx: RepoContext): string {
  const r = ctx.resource;
  const getArgs = ctx.upstreams.filter((u) => u.op.verb === 'GET').map((u) => snake(u.op.arg));
  return lines(
    'from datetime import datetime',
    ctx.amountField && 'from decimal import Decimal',
    '',
    'from pydantic import BaseModel, Field',
    '',
    '',
    `class ${r.pascal}(BaseModel):`,
    '    id: str',
    '    reference: str',
    '    status: str',
    ctx.amountField && '    amount: Decimal',
    '    created_at: datetime',
    '',
    '',
    `class Create${r.pascal}(BaseModel):`,
    '    reference: str = Field(min_length=1)',
    ...getArgs.map((a) => `    ${a}: str = Field(min_length=1)`),
    ctx.amountField && '    amount: Decimal = Field(gt=0)',
    '',
  );
}

function routesPy(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  return lines(
    'import httpx',
    'from fastapi import APIRouter, HTTPException, Query',
    k.features.problemJson && 'from fastapi.responses import JSONResponse',
    '',
    `from ${ctx.pyPackage} import service`,
    `from ${ctx.pyPackage}.config import settings`,
    `from ${ctx.pyPackage}.models import ${r.pascal}, Create${r.pascal}`,
    '',
    `router = APIRouter(prefix="/api/v1/${r.pluralKebab}", tags=["${r.pluralKebab}"])`,
    '',
    '',
    '@router.get("")',
    k.features.inputValidation
      ? `def list_${r.snake}s(page: int = 0, page_size: int = Query(50, ge=1, le=settings.max_page_size)) -> list[${r.pascal}]:`
      : `def list_${r.snake}s(page: int = 0, page_size: int = 50) -> list[${r.pascal}]:`,
    k.features.inputValidation
      ? `    return service.list_${r.snake}s(page, page_size)`
      : `    return service.list_${r.snake}s(page, min(page_size, settings.max_page_size))`,
    '',
    '',
    `@router.get("/{${r.snake}_id}")`,
    `def get_${r.snake}(${r.snake}_id: str) -> ${r.pascal}:`,
    `    found = service.get_${r.snake}(${r.snake}_id)`,
    '    if found is None:',
    `        raise HTTPException(status_code=404, detail=f"${r.title} {${r.snake}_id} not found")`,
    '    return found',
    '',
    '',
    '@router.post("", status_code=201)',
    `async def create_${r.snake}(body: Create${r.pascal}):`,
    '    try:',
    `        return await service.create_${r.snake}(body)`,
    '    except (httpx.TimeoutException, httpx.HTTPStatusError) as exc:',
    k.features.problemJson
      ? '        return JSONResponse(status_code=503, media_type="application/problem+json", content={"title": "Upstream unavailable", "status": 503, "detail": str(exc)})'
      : '        raise HTTPException(status_code=503, detail="upstream_unavailable") from exc',
    '',
  );
}

function mainPy(ctx: RepoContext, k: Knobs): string {
  return lines(
    'import logging',
    '',
    'import structlog',
    'from fastapi import FastAPI',
    k.features.requestIdHeader && 'from fastapi import Request',
    '',
    `from ${ctx.pyPackage} import __version__`,
    `from ${ctx.pyPackage}.api.routes import router`,
    `from ${ctx.pyPackage}.config import settings`,
    k.features.requestIdHeader && `from ${ctx.pyPackage}.context import request_id`,
    '',
    'logging.basicConfig(level=settings.log_level)',
    'structlog.configure(processors=[structlog.processors.add_log_level, structlog.processors.JSONRenderer()])',
    '',
    `app = FastAPI(title="${ctx.repo.name}", version=__version__)`,
    'app.include_router(router)',
    '',
    k.features.requestIdHeader && '',
    k.features.requestIdHeader && '@app.middleware("http")',
    k.features.requestIdHeader && 'async def propagate_request_id(request: Request, call_next):',
    k.features.requestIdHeader && '    request_id.set(request.headers.get("x-request-id", ""))',
    k.features.requestIdHeader && '    return await call_next(request)',
    k.features.requestIdHeader && '',
    '',
    '@app.get("/health/live")',
    'def live() -> dict:',
    '    return {"status": "UP"}',
    '',
    '',
    '@app.get("/health/ready")',
    'def ready() -> dict:',
    '    return {"status": "UP", "service": settings.service_name}',
    '',
  );
}

const EXTRA_TESTS: Record<string, (ctx: RepoContext) => [string, string] | null> = {
  validation: (ctx) => [
    'tests/test_validation.py',
    lines(
      'from fastapi.testclient import TestClient',
      '',
      `from ${ctx.pyPackage}.main import app`,
      '',
      'client = TestClient(app)',
      '',
      '',
      'def test_rejects_missing_reference():',
      `    response = client.post("/api/v1/${ctx.resource.pluralKebab}", json={})`,
      '    assert response.status_code == 422',
      '',
    ),
  ],
  'client-timeouts': (ctx) => {
    const u = ctx.upstreams[0];
    if (!u) return null;
    return [
      `tests/test_${u.lower}_client.py`,
      lines(
        'import httpx',
        'import pytest',
        'import respx',
        '',
        `from ${ctx.pyPackage}.clients import ${u.lower}`,
        '',
        '',
        '@respx.mock',
        `async def test_${u.lower}_timeout_raises():`,
        `    respx.route(host="${u.service}.${u.lower}00.svc.cluster.local").mock(side_effect=httpx.ReadTimeout("slow"))`,
        '    with pytest.raises(httpx.ReadTimeout):',
        u.op.verb === 'GET'
          ? `        await ${u.lower}.${snake(u.op.method)}("1")`
          : `        await ${u.lower}.${snake(u.op.method)}({})`,
        '',
      ),
    ];
  },
  'error-mapping': (ctx) => [
    'tests/test_errors.py',
    lines(
      'from fastapi.testclient import TestClient',
      '',
      `from ${ctx.pyPackage}.main import app`,
      '',
      '',
      'def test_unknown_record_is_404():',
      `    response = TestClient(app).get("/api/v1/${ctx.resource.pluralKebab}/missing")`,
      '    assert response.status_code == 404',
      '',
    ),
  ],
  serialization: (ctx) => [
    'tests/test_models.py',
    lines(
      'from datetime import UTC, datetime',
      '',
      `from ${ctx.pyPackage}.models import ${ctx.resource.pascal}`,
      '',
      '',
      'def test_round_trip():',
      `    value = ${ctx.resource.pascal}(id="1", reference="REF-1", status="ACCEPTED",${ctx.amountField ? ' amount="10.00",' : ''} created_at=datetime.now(UTC))`,
      `    assert ${ctx.resource.pascal}.model_validate_json(value.model_dump_json()) == value`,
      '',
    ),
  ],
};

export const PYTHON_EXTRA_TESTS = Object.keys(EXTRA_TESTS);

export function renderPython(ctx: RepoContext, k: Knobs): Files {
  const pkg = `src/${ctx.pyPackage}`;
  const r = ctx.resource;
  const files: Files = {
    'pyproject.toml': pyproject(ctx, k),
    [`${pkg}/__init__.py`]: `__version__ = "${k.version}"\n`,
    [`${pkg}/config.py`]: configPy(ctx, k),
    [`${pkg}/models.py`]: modelsPy(ctx),
    [`${pkg}/service.py`]: servicePy(ctx, k),
    [`${pkg}/main.py`]: mainPy(ctx, k),
    [`${pkg}/api/__init__.py`]: '',
    [`${pkg}/api/routes.py`]: routesPy(ctx, k),
    [`${pkg}/clients/__init__.py`]: '',
  };
  if (k.features.requestIdHeader) {
    files[`${pkg}/context.py`] = lines(
      'from contextvars import ContextVar',
      '',
      'request_id: ContextVar[str] = ContextVar("request_id", default="")',
      '',
    );
  }
  for (const u of ctx.upstreams) files[`${pkg}/clients/${u.lower}.py`] = clientPy(ctx, k, u);
  if (ctx.repo.kind === 'batch') {
    files[`${pkg}/jobs.py`] = lines(
      `"""Nightly ${r.title.toLowerCase()} batch, run by a Kubernetes CronJob."""`,
      '',
      'import structlog',
      '',
      `from ${ctx.pyPackage} import service`,
      '',
      'log = structlog.get_logger(__name__)',
      '',
      '',
      'def run(chunk_size: int = 500) -> int:',
      '    processed = 0',
      '    page = 0',
      '    while batch := service.list_' + r.snake + 's(page, chunk_size):',
      '        processed += len(batch)',
      '        page += 1',
      `    log.info("${r.snake}_job_finished", processed=processed)`,
      '    return processed',
      '',
      '',
      'if __name__ == "__main__":',
      '    run()',
      '',
    );
  }
  files[`tests/test_${r.snake}_api.py`] = lines(
    'from fastapi.testclient import TestClient',
    '',
    `from ${ctx.pyPackage}.main import app`,
    '',
    'client = TestClient(app)',
    '',
    '',
    'def test_health():',
    '    assert client.get("/health/live").json() == {"status": "UP"}',
    '',
    '',
    `def test_list_${r.snake}s_empty():`,
    `    assert client.get("/api/v1/${r.pluralKebab}").json() == []`,
    '',
  );
  for (const key of k.extraTests) {
    const out = EXTRA_TESTS[key]?.(ctx);
    if (out) files[out[0]] = out[1];
  }
  return files;
}
