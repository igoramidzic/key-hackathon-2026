// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated source code contains literal ${...} placeholders
import { javaPath, type Knobs, lines, type RepoContext, type UpstreamInfo } from './context';

type Files = Record<string, string>;

const ms = (n: number) => (n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`);

function pom(ctx: RepoContext, k: Knobs): string {
  const batch = ctx.repo.kind === 'batch';
  const dep = (g: string, a: string, extra: string[] = []) =>
    lines(
      '    <dependency>',
      `      <groupId>${g}</groupId>`,
      `      <artifactId>${a}</artifactId>`,
      ...extra.map((e) => `      ${e}`),
      '    </dependency>',
    );
  return lines(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<project xmlns="http://maven.apache.org/POM/4.0.0"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
    '  <modelVersion>4.0.0</modelVersion>',
    '',
    '  <parent>',
    '    <groupId>org.springframework.boot</groupId>',
    '    <artifactId>spring-boot-starter-parent</artifactId>',
    `    <version>${k.deps['spring-boot']}</version>`,
    '    <relativePath/>',
    '  </parent>',
    '',
    `  <groupId>${ctx.javaPackage}</groupId>`,
    `  <artifactId>${ctx.repo.name}</artifactId>`,
    `  <version>${k.version}</version>`,
    `  <name>${ctx.repo.name}</name>`,
    `  <description>${ctx.repo.description}</description>`,
    '',
    '  <properties>',
    '    <java.version>21</java.version>',
    `    <resilience4j.version>${k.deps.resilience4j}</resilience4j.version>`,
    `    <logstash-logback-encoder.version>${k.deps['logstash-logback-encoder']}</logstash-logback-encoder.version>`,
    `    <wiremock.version>${k.deps.wiremock}</wiremock.version>`,
    `    <jacoco.version>${k.deps.jacoco}</jacoco.version>`,
    '  </properties>',
    '',
    '  <dependencies>',
    dep('org.springframework.boot', batch ? 'spring-boot-starter' : 'spring-boot-starter-web'),
    batch && dep('org.springframework.boot', 'spring-boot-starter-web'),
    dep('org.springframework.boot', 'spring-boot-starter-actuator'),
    dep('org.springframework.boot', 'spring-boot-starter-validation'),
    k.cacheTtlSec > 0 && dep('org.springframework.boot', 'spring-boot-starter-cache'),
    k.cacheTtlSec > 0 && dep('com.github.ben-manes.caffeine', 'caffeine'),
    dep('io.github.resilience4j', 'resilience4j-spring-boot3', [
      '<version>${resilience4j.version}</version>',
    ]),
    dep('io.micrometer', 'micrometer-registry-prometheus'),
    dep('net.logstash.logback', 'logstash-logback-encoder', [
      '<version>${logstash-logback-encoder.version}</version>',
    ]),
    '',
    dep('org.springframework.boot', 'spring-boot-starter-test', ['<scope>test</scope>']),
    dep('org.wiremock', 'wiremock-standalone', [
      '<version>${wiremock.version}</version>',
      '<scope>test</scope>',
    ]),
    '  </dependencies>',
    '',
    '  <build>',
    '    <plugins>',
    '      <plugin>',
    '        <groupId>org.springframework.boot</groupId>',
    '        <artifactId>spring-boot-maven-plugin</artifactId>',
    '      </plugin>',
    '      <plugin>',
    '        <groupId>org.jacoco</groupId>',
    '        <artifactId>jacoco-maven-plugin</artifactId>',
    '        <version>${jacoco.version}</version>',
    '        <executions>',
    '          <execution>',
    '            <goals><goal>prepare-agent</goal><goal>report</goal></goals>',
    '          </execution>',
    '        </executions>',
    '      </plugin>',
    '    </plugins>',
    '  </build>',
    '</project>',
    '',
  );
}

function applicationYml(ctx: RepoContext, k: Knobs): string {
  return lines(
    'server:',
    '  port: 8080',
    '  shutdown: graceful',
    '',
    'spring:',
    '  application:',
    `    name: ${ctx.repo.name}`,
    '  lifecycle:',
    '    timeout-per-shutdown-phase: 20s',
    k.cacheTtlSec > 0 && '  cache:',
    k.cacheTtlSec > 0 && '    type: caffeine',
    k.cacheTtlSec > 0 && '    caffeine:',
    k.cacheTtlSec > 0 && `      spec: maximumSize=10000,expireAfterWrite=${k.cacheTtlSec}s`,
    '',
    'management:',
    '  endpoints:',
    '    web:',
    '      exposure:',
    '        include: health,info,prometheus',
    '  endpoint:',
    '    health:',
    '      probes:',
    '        enabled: true',
    '',
    'logging:',
    '  level:',
    '    root: INFO',
    `    ${ctx.javaPackage}: ${k.logLevel}`,
    '',
    `${ctx.tlaLower}:`,
    `  page-size-max: ${k.maxPageSize}`,
    '  http:',
    `    max-connections: ${k.poolSize}`,
    ctx.repo.kind === 'batch' && '  jobs:',
    ctx.repo.kind === 'batch' && `    ${ctx.resource.kebab}-cron: "0 15 2 * * *"`,
    ctx.repo.kind === 'batch' && '    chunk-size: 500',
    '',
    ctx.upstreams.length > 0 && 'upstream:',
    ...ctx.upstreams.flatMap((u) => {
      const t = k.timeouts[u.tla]!;
      return [
        `  ${u.lower}:`,
        `    base-url: \${${u.envVar}:${u.baseUrl}}`,
        `    connect-timeout: ${ms(t.connectMs)}`,
        `    read-timeout: ${ms(t.readMs)}`,
        `    max-retries: ${t.retries}`,
      ];
    }),
    ctx.upstreams.length > 0 && '',
    ctx.upstreams.length > 0 && 'resilience4j:',
    ctx.upstreams.length > 0 && '  retry:',
    ctx.upstreams.length > 0 && '    instances:',
    ...ctx.upstreams.flatMap((u) => [
      `      ${u.lower}:`,
      `        max-attempts: ${k.timeouts[u.tla]!.retries + 1}`,
      '        wait-duration: 200ms',
      '        enable-exponential-backoff: true',
    ]),
    ctx.upstreams.length > 0 && '  circuitbreaker:',
    ctx.upstreams.length > 0 && '    instances:',
    ...ctx.upstreams.flatMap((u) => [
      `      ${u.lower}:`,
      '        sliding-window-size: 50',
      '        failure-rate-threshold: 50',
      '        wait-duration-in-open-state: 30s',
    ]),
    '',
  );
}

function application(ctx: RepoContext, k: Knobs): string {
  const cls = `${ctx.repoNames.pascal}Application`;
  return lines(
    `package ${ctx.javaPackage};`,
    '',
    `import ${ctx.javaPackage}.config.UpstreamProperties;`,
    'import org.springframework.boot.SpringApplication;',
    'import org.springframework.boot.autoconfigure.SpringBootApplication;',
    'import org.springframework.boot.context.properties.EnableConfigurationProperties;',
    k.cacheTtlSec > 0 && 'import org.springframework.cache.annotation.EnableCaching;',
    ctx.repo.kind === 'batch' &&
      'import org.springframework.scheduling.annotation.EnableScheduling;',
    '',
    `/** ${ctx.app.name} (${ctx.tla}) — ${ctx.repo.description} */`,
    '@SpringBootApplication',
    '@EnableConfigurationProperties(UpstreamProperties.class)',
    k.cacheTtlSec > 0 && '@EnableCaching',
    ctx.repo.kind === 'batch' && '@EnableScheduling',
    `public class ${cls} {`,
    '',
    '    public static void main(String[] args) {',
    `        SpringApplication.run(${cls}.class, args);`,
    '    }',
    '}',
    '',
  );
}

function upstreamProperties(ctx: RepoContext): string {
  const fields = ctx.upstreams.map((u) => `Upstream ${u.lower}`).join(',\n        ');
  return lines(
    `package ${ctx.javaPackage}.config;`,
    '',
    'import java.time.Duration;',
    'import org.springframework.boot.context.properties.ConfigurationProperties;',
    '',
    '/** Base URLs and timeouts for every upstream application (see application.yml). */',
    '@ConfigurationProperties(prefix = "upstream")',
    `public record UpstreamProperties(${fields ? `\n        ${fields}` : ''}) {`,
    '',
    '    public record Upstream(String baseUrl, Duration connectTimeout, Duration readTimeout, int maxRetries) {}',
    '}',
    '',
  );
}

function httpClientConfig(ctx: RepoContext): string {
  return lines(
    `package ${ctx.javaPackage}.config;`,
    '',
    'import java.net.http.HttpClient;',
    'import java.util.concurrent.Executors;',
    'import org.springframework.beans.factory.annotation.Value;',
    'import org.springframework.context.annotation.Bean;',
    'import org.springframework.context.annotation.Configuration;',
    'import org.springframework.http.client.JdkClientHttpRequestFactory;',
    'import org.springframework.web.client.RestClient;',
    '',
    '@Configuration',
    'public class HttpClientConfig {',
    '',
    `    @Value("\${${ctx.tlaLower}.http.max-connections}")`,
    '    private int maxConnections;',
    ...ctx.upstreams.flatMap((u) => [
      '',
      '    @Bean',
      `    RestClient ${u.lower}RestClient(UpstreamProperties props, RestClient.Builder builder) {`,
      `        return build(builder, props.${u.lower}());`,
      '    }',
    ]),
    '',
    '    private RestClient build(RestClient.Builder builder, UpstreamProperties.Upstream upstream) {',
    '        HttpClient http = HttpClient.newBuilder()',
    '                .connectTimeout(upstream.connectTimeout())',
    '                .executor(Executors.newFixedThreadPool(maxConnections))',
    '                .build();',
    '        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);',
    '        factory.setReadTimeout(upstream.readTimeout());',
    '        return builder.clone().baseUrl(upstream.baseUrl()).requestFactory(factory).build();',
    '    }',
    '}',
    '',
  );
}

function client(ctx: RepoContext, k: Knobs, u: UpstreamInfo): string {
  const cls = `${u.pascal}Client`;
  const op = u.op;
  const get = op.verb === 'GET';
  const call = get
    ? [
        `        return restClient.get()`,
        `                .uri("${op.path}", ${op.arg})`,
        k.features.requestIdHeader &&
          '                .header("X-Request-Id", MDC.get("requestId"))',
        '                .retrieve()',
        `                .body(${op.model}.class);`,
      ]
    : [
        `        return restClient.post()`,
        `                .uri("${op.path}")`,
        k.features.requestIdHeader &&
          '                .header("X-Request-Id", MDC.get("requestId"))',
        `                .body(${op.arg})`,
        '                .retrieve()',
        `                .body(${op.model}.class);`,
      ];
  return lines(
    `package ${ctx.javaPackage}.client;`,
    '',
    k.features.retryOnTimeout && 'import io.github.resilience4j.retry.annotation.Retry;',
    'import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;',
    k.features.clientMetrics && 'import io.micrometer.core.annotation.Timed;',
    !get && 'import java.util.Map;',
    k.features.requestIdHeader && 'import org.slf4j.MDC;',
    'import org.springframework.beans.factory.annotation.Qualifier;',
    'import org.springframework.stereotype.Component;',
    'import org.springframework.web.client.RestClient;',
    '',
    `/** Client for ${u.appName} (${u.tla}), service \`${u.service}\`. */`,
    '@Component',
    `public class ${cls} {`,
    '',
    '    private final RestClient restClient;',
    '',
    `    public ${cls}(@Qualifier("${u.lower}RestClient") RestClient restClient) {`,
    '        this.restClient = restClient;',
    '    }',
    '',
    `    /** ${op.summary}. */`,
    `    @CircuitBreaker(name = "${u.lower}")`,
    k.features.retryOnTimeout && `    @Retry(name = "${u.lower}")`,
    k.features.clientMetrics &&
      `    @Timed(value = "upstream.requests", extraTags = {"upstream", "${u.tla}"})`,
    `    public ${op.model} ${op.method}(${get ? 'String' : 'Map<String, Object>'} ${op.arg}) {`,
    ...call,
    '    }',
    '',
    `    public record ${op.model}(String id, String status) {}`,
    '}',
    '',
  );
}

function model(ctx: RepoContext): string {
  const r = ctx.resource.pascal;
  const getArgs = ctx.upstreams.filter((u) => u.op.verb === 'GET').map((u) => u.op.arg);
  const reqFields = [
    '@NotBlank String reference',
    ...getArgs.map((a) => `@NotBlank String ${a}`),
    ctx.amountField && '@NotNull @Positive BigDecimal amount',
  ].filter((f): f is string => Boolean(f));
  return lines(
    `package ${ctx.javaPackage}.model;`,
    '',
    'import jakarta.validation.constraints.NotBlank;',
    ctx.amountField && 'import jakarta.validation.constraints.NotNull;',
    ctx.amountField && 'import jakarta.validation.constraints.Positive;',
    ctx.amountField && 'import java.math.BigDecimal;',
    'import java.time.Instant;',
    '',
    `public record ${r}(`,
    '        String id,',
    '        String reference,',
    '        String status,',
    ctx.amountField && '        BigDecimal amount,',
    '        Instant createdAt) {',
    '',
    '    public record CreateRequest(',
    `            ${reqFields.join(',\n            ')}) {}`,
    '}',
    '',
  );
}

function service(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  const ups = ctx.upstreams;
  const calls = ups.flatMap((u) => {
    const v = u.op.model[0]!.toLowerCase() + u.op.model.slice(1);
    if (u.op.verb === 'GET') {
      return [`        var ${v} = ${u.lower}Client.${u.op.method}(request.${u.op.arg}());`];
    }
    return [
      `        var ${v} = ${u.lower}Client.${u.op.method}(Map.of("reference", request.reference(), "source", "${ctx.repo.name}"));`,
    ];
  });
  return lines(
    `package ${ctx.javaPackage}.service;`,
    '',
    ...ups.map((u) => `import ${ctx.javaPackage}.client.${u.pascal}Client;`),
    `import ${ctx.javaPackage}.model.${r.pascal};`,
    'import java.time.Instant;',
    'import java.util.List;',
    'import java.util.Map;',
    'import java.util.UUID;',
    'import java.util.concurrent.ConcurrentHashMap;',
    'import org.slf4j.Logger;',
    'import org.slf4j.LoggerFactory;',
    k.cacheTtlSec > 0 && 'import org.springframework.cache.annotation.Cacheable;',
    'import org.springframework.http.HttpStatus;',
    'import org.springframework.stereotype.Service;',
    'import org.springframework.web.server.ResponseStatusException;',
    '',
    '@Service',
    `public class ${r.pascal}Service {`,
    '',
    `    private static final Logger log = LoggerFactory.getLogger(${r.pascal}Service.class);`,
    '',
    `    private final Map<String, ${r.pascal}> store = new ConcurrentHashMap<>();`,
    ...ups.map((u) => `    private final ${u.pascal}Client ${u.lower}Client;`),
    '',
    `    public ${r.pascal}Service(${ups.map((u) => `${u.pascal}Client ${u.lower}Client`).join(', ')}) {`,
    ...ups.map((u) => `        this.${u.lower}Client = ${u.lower}Client;`),
    '    }',
    '',
    k.cacheTtlSec > 0 && `    @Cacheable(cacheNames = "${r.pluralKebab}", key = "#id")`,
    `    public ${r.pascal} get(String id) {`,
    `        ${r.pascal} found = store.get(id);`,
    '        if (found == null) {',
    `            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "${r.title} " + id + " not found");`,
    '        }',
    '        return found;',
    '    }',
    '',
    `    public List<${r.pascal}> list(int page, int size) {`,
    '        return store.values().stream().skip((long) page * size).limit(size).toList();',
    '    }',
    '',
    `    public ${r.pascal} create(${r.pascal}.CreateRequest request) {`,
    ...calls,
    `        ${r.pascal} created = new ${r.pascal}(`,
    '                UUID.randomUUID().toString(),',
    '                request.reference(),',
    '                "ACCEPTED",',
    ctx.amountField && '                request.amount(),',
    '                Instant.now());',
    '        store.put(created.id(), created);',
    `        log.info("Created ${r.title.toLowerCase()} {} (reference {})", created.id(), request.reference());`,
    '        return created;',
    '    }',
    '}',
    '',
  );
}

function controller(ctx: RepoContext, k: Knobs): string {
  const r = ctx.resource;
  return lines(
    `package ${ctx.javaPackage}.api;`,
    '',
    `import ${ctx.javaPackage}.model.${r.pascal};`,
    `import ${ctx.javaPackage}.service.${r.pascal}Service;`,
    'import jakarta.validation.Valid;',
    'import java.util.List;',
    'import org.springframework.beans.factory.annotation.Value;',
    'import org.springframework.http.HttpStatus;',
    'import org.springframework.web.bind.annotation.*;',
    k.features.inputValidation && 'import org.springframework.web.server.ResponseStatusException;',
    '',
    '@RestController',
    `@RequestMapping("/api/v1/${r.pluralKebab}")`,
    `public class ${r.pascal}Controller {`,
    '',
    `    private final ${r.pascal}Service service;`,
    '    private final int maxPageSize;',
    '',
    `    public ${r.pascal}Controller(${r.pascal}Service service, @Value("\${${ctx.tlaLower}.page-size-max}") int maxPageSize) {`,
    '        this.service = service;',
    '        this.maxPageSize = maxPageSize;',
    '    }',
    '',
    '    @GetMapping',
    `    public List<${r.pascal}> list(@RequestParam(defaultValue = "0") int page,`,
    '                                 @RequestParam(defaultValue = "50") int pageSize) {',
    k.features.inputValidation && '        if (pageSize < 1 || pageSize > maxPageSize) {',
    k.features.inputValidation &&
      '            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "pageSize must be between 1 and " + maxPageSize);',
    k.features.inputValidation && '        }',
    k.features.inputValidation
      ? '        return service.list(page, pageSize);'
      : '        return service.list(page, Math.min(pageSize, maxPageSize));',
    '    }',
    '',
    '    @GetMapping("/{id}")',
    `    public ${r.pascal} get(@PathVariable String id) {`,
    '        return service.get(id);',
    '    }',
    '',
    '    @PostMapping',
    '    @ResponseStatus(HttpStatus.CREATED)',
    `    public ${r.pascal} create(@Valid @RequestBody ${r.pascal}.CreateRequest request) {`,
    '        return service.create(request);',
    '    }',
    '}',
    '',
  );
}

function exceptionHandler(ctx: RepoContext, k: Knobs): string {
  const problem = k.features.problemJson;
  return lines(
    `package ${ctx.javaPackage}.api;`,
    '',
    'import io.github.resilience4j.circuitbreaker.CallNotPermittedException;',
    !problem && 'import java.util.Map;',
    'import org.slf4j.Logger;',
    'import org.slf4j.LoggerFactory;',
    'import org.springframework.http.HttpStatus;',
    problem && 'import org.springframework.http.ProblemDetail;',
    !problem && 'import org.springframework.http.ResponseEntity;',
    'import org.springframework.web.bind.annotation.ExceptionHandler;',
    'import org.springframework.web.bind.annotation.RestControllerAdvice;',
    'import org.springframework.web.client.ResourceAccessException;',
    'import org.springframework.web.client.RestClientResponseException;',
    '',
    '@RestControllerAdvice',
    'public class ApiExceptionHandler {',
    '',
    '    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);',
    '',
    '    @ExceptionHandler({ResourceAccessException.class, CallNotPermittedException.class})',
    problem
      ? '    public ProblemDetail upstreamUnavailable(RuntimeException ex) {'
      : '    public ResponseEntity<Map<String, Object>> upstreamUnavailable(RuntimeException ex) {',
    '        log.warn("Upstream unavailable: {}", ex.getMessage());',
    problem
      ? '        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, "Upstream dependency unavailable");'
      : '        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)',
    problem
      ? '        pd.setTitle("Upstream unavailable");'
      : '                .body(Map.of("error", "upstream_unavailable", "message", "Upstream dependency unavailable"));',
    problem && '        return pd;',
    '    }',
    '',
    '    @ExceptionHandler(RestClientResponseException.class)',
    problem
      ? '    public ProblemDetail upstreamError(RestClientResponseException ex) {'
      : '    public ResponseEntity<Map<String, Object>> upstreamError(RestClientResponseException ex) {',
    '        log.error("Upstream returned {}: {}", ex.getStatusCode(), ex.getResponseBodyAsString());',
    problem
      ? '        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY, "Upstream returned " + ex.getStatusCode().value());'
      : '        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)',
    !problem &&
      '                .body(Map.of("error", "upstream_error", "status", ex.getStatusCode().value()));',
    '    }',
    '}',
    '',
  );
}

function job(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    `package ${ctx.javaPackage}.job;`,
    '',
    `import ${ctx.javaPackage}.service.${r.pascal}Service;`,
    'import org.slf4j.Logger;',
    'import org.slf4j.LoggerFactory;',
    'import org.springframework.beans.factory.annotation.Value;',
    'import org.springframework.scheduling.annotation.Scheduled;',
    'import org.springframework.stereotype.Component;',
    '',
    `/** Nightly ${r.title.toLowerCase()} batch for ${ctx.app.name}. */`,
    '@Component',
    `public class ${r.pascal}Job {`,
    '',
    `    private static final Logger log = LoggerFactory.getLogger(${r.pascal}Job.class);`,
    '',
    `    private final ${r.pascal}Service service;`,
    '    private final int chunkSize;',
    '',
    `    public ${r.pascal}Job(${r.pascal}Service service, @Value("\${${ctx.tlaLower}.jobs.chunk-size}") int chunkSize) {`,
    '        this.service = service;',
    '        this.chunkSize = chunkSize;',
    '    }',
    '',
    `    @Scheduled(cron = "\${${ctx.tlaLower}.jobs.${r.kebab}-cron}", zone = "America/New_York")`,
    '    public void run() {',
    '        long started = System.currentTimeMillis();',
    '        int page = 0;',
    '        int processed = 0;',
    '        while (true) {',
    '            var batch = service.list(page++, chunkSize);',
    '            if (batch.isEmpty()) break;',
    '            processed += batch.size();',
    '        }',
    `        log.info("${r.title} job finished: {} records in {} ms", processed, System.currentTimeMillis() - started);`,
    '    }',
    '}',
    '',
  );
}

function controllerTest(ctx: RepoContext): string {
  const r = ctx.resource;
  return lines(
    `package ${ctx.javaPackage}.api;`,
    '',
    `import ${ctx.javaPackage}.model.${r.pascal};`,
    `import ${ctx.javaPackage}.service.${r.pascal}Service;`,
    'import java.time.Instant;',
    'import org.junit.jupiter.api.Test;',
    'import org.springframework.beans.factory.annotation.Autowired;',
    'import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;',
    'import org.springframework.boot.test.mock.mockito.MockBean;',
    'import org.springframework.test.web.servlet.MockMvc;',
    '',
    'import static org.mockito.Mockito.when;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;',
    '',
    `@WebMvcTest(${r.pascal}Controller.class)`,
    `class ${r.pascal}ControllerTest {`,
    '',
    '    @Autowired',
    '    private MockMvc mvc;',
    '',
    '    @MockBean',
    `    private ${r.pascal}Service service;`,
    '',
    '    @Test',
    '    void returnsRecordById() throws Exception {',
    `        when(service.get("abc")).thenReturn(new ${r.pascal}("abc", "REF-1", "ACCEPTED",${ctx.amountField ? ' null,' : ''} Instant.now()));`,
    `        mvc.perform(get("/api/v1/${r.pluralKebab}/abc"))`,
    '                .andExpect(status().isOk())',
    '                .andExpect(jsonPath("$.reference").value("REF-1"));',
    '    }',
    '}',
    '',
  );
}

function serviceTest(ctx: RepoContext): string {
  const r = ctx.resource;
  const ups = ctx.upstreams;
  const getArgs = ups.filter((u) => u.op.verb === 'GET').map((u) => `"${u.op.arg}-1"`);
  const args = ['"REF-1"', ...getArgs, ctx.amountField ? 'new BigDecimal("125.00")' : null].filter(
    Boolean,
  );
  return lines(
    `package ${ctx.javaPackage}.service;`,
    '',
    ...ups.map((u) => `import ${ctx.javaPackage}.client.${u.pascal}Client;`),
    `import ${ctx.javaPackage}.model.${r.pascal};`,
    ctx.amountField && 'import java.math.BigDecimal;',
    'import org.junit.jupiter.api.Test;',
    '',
    'import static org.assertj.core.api.Assertions.assertThat;',
    'import static org.mockito.Mockito.mock;',
    '',
    `class ${r.pascal}ServiceTest {`,
    '',
    ...ups.map(
      (u) =>
        `    private final ${u.pascal}Client ${u.lower}Client = mock(${u.pascal}Client.class);`,
    ),
    `    private final ${r.pascal}Service service = new ${r.pascal}Service(${ups.map((u) => `${u.lower}Client`).join(', ')});`,
    '',
    '    @Test',
    '    void createStoresRecord() {',
    `        var created = service.create(new ${r.pascal}.CreateRequest(${args.join(', ')}));`,
    '        assertThat(service.get(created.id())).isEqualTo(created);',
    '        assertThat(created.status()).isEqualTo("ACCEPTED");',
    '    }',
    '}',
    '',
  );
}

const EXTRA_TESTS: Record<string, (ctx: RepoContext) => [string, string] | null> = {
  validation: (ctx) => [
    javaPath(ctx, `api/${ctx.resource.pascal}ValidationTest.java`, true),
    lines(
      `package ${ctx.javaPackage}.api;`,
      '',
      'import org.junit.jupiter.api.Test;',
      'import org.springframework.beans.factory.annotation.Autowired;',
      'import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;',
      'import org.springframework.boot.test.mock.mockito.MockBean;',
      'import org.springframework.http.MediaType;',
      'import org.springframework.test.web.servlet.MockMvc;',
      `import ${ctx.javaPackage}.service.${ctx.resource.pascal}Service;`,
      '',
      'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;',
      'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;',
      '',
      `@WebMvcTest(${ctx.resource.pascal}Controller.class)`,
      `class ${ctx.resource.pascal}ValidationTest {`,
      '',
      '    @Autowired',
      '    private MockMvc mvc;',
      '',
      '    @MockBean',
      `    private ${ctx.resource.pascal}Service service;`,
      '',
      '    @Test',
      '    void rejectsMissingReference() throws Exception {',
      `        mvc.perform(post("/api/v1/${ctx.resource.pluralKebab}").contentType(MediaType.APPLICATION_JSON).content("{}"))`,
      '                .andExpect(status().isBadRequest());',
      '    }',
      '}',
      '',
    ),
  ],
  'client-timeouts': (ctx) => {
    const u = ctx.upstreams.find((x) => x.op.verb === 'GET') ?? ctx.upstreams[0];
    if (!u) return null;
    return [
      javaPath(ctx, `client/${u.pascal}ClientTest.java`, true),
      lines(
        `package ${ctx.javaPackage}.client;`,
        '',
        'import com.github.tomakehurst.wiremock.junit5.WireMockTest;',
        'import com.github.tomakehurst.wiremock.junit5.WireMockRuntimeInfo;',
        'import org.junit.jupiter.api.Test;',
        'import org.springframework.web.client.RestClient;',
        '',
        'import static com.github.tomakehurst.wiremock.client.WireMock.*;',
        'import static org.assertj.core.api.Assertions.assertThat;',
        '',
        '@WireMockTest',
        `class ${u.pascal}ClientTest {`,
        '',
        '    @Test',
        '    void parsesResponse(WireMockRuntimeInfo wm) {',
        `        stubFor(any(urlPathMatching("${u.op.path.replace('{id}', '.*')}")).willReturn(okJson("{\\"id\\":\\"1\\",\\"status\\":\\"OK\\"}")));`,
        `        var client = new ${u.pascal}Client(RestClient.builder().baseUrl(wm.getHttpBaseUrl()).build());`,
        u.op.verb === 'GET'
          ? `        assertThat(client.${u.op.method}("1").status()).isEqualTo("OK");`
          : `        assertThat(client.${u.op.method}(java.util.Map.of()).status()).isEqualTo("OK");`,
        '    }',
        '}',
        '',
      ),
    ];
  },
  'error-mapping': (ctx) => [
    javaPath(ctx, 'api/ApiExceptionHandlerTest.java', true),
    lines(
      `package ${ctx.javaPackage}.api;`,
      '',
      'import org.junit.jupiter.api.Test;',
      'import org.springframework.web.client.ResourceAccessException;',
      '',
      'import static org.assertj.core.api.Assertions.assertThat;',
      '',
      'class ApiExceptionHandlerTest {',
      '',
      '    private final ApiExceptionHandler handler = new ApiExceptionHandler();',
      '',
      '    @Test',
      '    void mapsTimeoutsTo503() {',
      '        var result = handler.upstreamUnavailable(new ResourceAccessException("Read timed out"));',
      '        assertThat(result).isNotNull();',
      '    }',
      '}',
      '',
    ),
  ],
  serialization: (ctx) => [
    javaPath(ctx, `model/${ctx.resource.pascal}JsonTest.java`, true),
    lines(
      `package ${ctx.javaPackage}.model;`,
      '',
      'import org.junit.jupiter.api.Test;',
      'import org.springframework.beans.factory.annotation.Autowired;',
      'import org.springframework.boot.test.autoconfigure.json.JsonTest;',
      'import org.springframework.boot.test.json.JacksonTester;',
      '',
      'import static org.assertj.core.api.Assertions.assertThat;',
      '',
      '@JsonTest',
      `class ${ctx.resource.pascal}JsonTest {`,
      '',
      '    @Autowired',
      `    private JacksonTester<${ctx.resource.pascal}> json;`,
      '',
      '    @Test',
      '    void serializesCreatedAtAsIso8601() throws Exception {',
      `        var value = new ${ctx.resource.pascal}("1", "REF-1", "ACCEPTED",${ctx.amountField ? ' null,' : ''} java.time.Instant.parse("2024-01-01T00:00:00Z"));`,
      '        assertThat(json.write(value)).extractingJsonPathStringValue("$.createdAt").isEqualTo("2024-01-01T00:00:00Z");',
      '    }',
      '}',
      '',
    ),
  ],
};

export const JAVA_EXTRA_TESTS = Object.keys(EXTRA_TESTS);

export function renderJava(ctx: RepoContext, k: Knobs): Files {
  const files: Files = {};
  const r = ctx.resource.pascal;
  files['pom.xml'] = pom(ctx, k);
  files['src/main/resources/application.yml'] = applicationYml(ctx, k);
  files[javaPath(ctx, `${ctx.repoNames.pascal}Application.java`)] = application(ctx, k);
  files[javaPath(ctx, 'config/UpstreamProperties.java')] = upstreamProperties(ctx);
  if (ctx.upstreams.length > 0) {
    files[javaPath(ctx, 'config/HttpClientConfig.java')] = httpClientConfig(ctx);
  }
  for (const u of ctx.upstreams)
    files[javaPath(ctx, `client/${u.pascal}Client.java`)] = client(ctx, k, u);
  files[javaPath(ctx, `model/${r}.java`)] = model(ctx);
  files[javaPath(ctx, `service/${r}Service.java`)] = service(ctx, k);
  if (ctx.repo.kind === 'batch') {
    files[javaPath(ctx, `job/${r}Job.java`)] = job(ctx);
  } else {
    files[javaPath(ctx, `api/${r}Controller.java`)] = controller(ctx, k);
    files[javaPath(ctx, 'api/ApiExceptionHandler.java')] = exceptionHandler(ctx, k);
    files[javaPath(ctx, `api/${r}ControllerTest.java`, true)] = controllerTest(ctx);
  }
  files[javaPath(ctx, `service/${r}ServiceTest.java`, true)] = serviceTest(ctx);
  for (const key of k.extraTests) {
    const out = EXTRA_TESTS[key]?.(ctx);
    if (out) files[out[0]] = out[1];
  }
  return files;
}
