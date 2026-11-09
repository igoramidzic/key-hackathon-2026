import type { AlertManager, AlertSeverity, Severity } from '@sim/contracts/logs';
import { getApp, getGroup, getWorld } from '@sim/world';
import type { LogContext, LogTemplate, RenderedLog, ScenarioAlert } from './types';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** The i-th developer of an app (deterministic: the world is seeded). */
export function dev(tla: string, index: number): string {
  const devs = getApp(tla).developerUsernames;
  return devs[index % devs.length]!;
}

/** First member of a shared group whose title matches, e.g. a DBA. */
export function groupMember(groupId: string, titlePattern: RegExp): string {
  const group = getGroup(groupId);
  const world = getWorld();
  const match = group.memberUsernames.find((u) =>
    titlePattern.test(world.peopleByUsername.get(u)?.title ?? ''),
  );
  return match ?? group.memberUsernames[0]!;
}

// ---------------------------------------------------------------------------
// Source helpers: keep stack traces pointing at real lines of the overlays
// ---------------------------------------------------------------------------

/** 1-based line number of the first line containing `needle`. Throws if absent. */
export function lineOf(content: string, needle: string): number {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`lineOf: "${needle}" not found`);
  return index + 1;
}

/** 1-based column where `needle` starts on its line. */
export function colOf(content: string, needle: string): number {
  const line = content.split('\n')[lineOf(content, needle) - 1]!;
  return line.indexOf(needle) + 1;
}

/** Line of `lineNeedle` and the 1-based column of `colNeedle` on that line (stack frame position). */
export function pos(
  content: string,
  lineNeedle: string,
  colNeedle: string = lineNeedle,
): { line: number; col: number } {
  const line = lineOf(content, lineNeedle);
  const text = content.split('\n')[line - 1]!;
  const index = text.indexOf(colNeedle);
  return { line, col: (index >= 0 ? index : text.search(/\S/)) + 1 };
}

/** The source line containing `needle`. */
export function sourceLine(content: string, needle: string): string {
  return content.split('\n')[lineOf(content, needle) - 1]!;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

export function tpl(
  severity: Severity,
  render: (ctx: LogContext) => RenderedLog,
  weight = 1,
): LogTemplate {
  return { severity, weight, render };
}

/** Latency in seconds, rounded to milliseconds. */
export function latency(ctx: LogContext, minSec: number, maxSec: number): number {
  return Math.round(ctx.rng.float(minSec, maxSec) * 1000) / 1000;
}

export function tomcatThread(ctx: LogContext): string {
  return `http-nio-8080-exec-${ctx.rng.int(1, 200)}`;
}

export function isoSecondsAgo(ctx: LogContext, seconds: number): string {
  return new Date(ctx.now.getTime() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Short trace id field used by MDC / pino bindings (first 16 hex chars). */
export function shortTrace(ctx: LogContext): string {
  return ctx.traceId().replace(/-/g, '').slice(0, 16);
}

/** Random v4-style UUID from the template RNG. */
export function uuid(ctx: LogContext): string {
  const h = ctx.rng.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function paymentId(ctx: LogContext): string {
  return `PMT-${yyyymmdd(ctx.now)}-${String(ctx.rng.int(1, 999_999)).padStart(6, '0')}`;
}

export function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Calendar date (YYYY-MM-DD) in the bank's business time zone. */
export function easternDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Next weekday after `isoDate` (YYYY-MM-DD). */
export function nextWeekday(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** Logback `%logger{36}` style abbreviation: `c.k.pay.client.CustomerProfileClient`. */
export function abbreviateLogger(name: string, target = 36): string {
  if (name.includes('[')) return name;
  const parts = name.split('.');
  // House style: the org prefix is always shortened (`c.k.`), the rest only as needed.
  const forced = name.startsWith('com.keybank.') ? 2 : 0;
  for (let i = 0; i < forced; i++) parts[i] = parts[i]!.charAt(0);
  if (parts.join('.').length <= target) return parts.join('.');
  for (let i = forced; i < parts.length - 1; i++) {
    parts[i] = parts[i]!.charAt(0);
    if (parts.join('.').length <= target) break;
  }
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// Java stack traces (logstash-logback-encoder `stack_trace` format)
// ---------------------------------------------------------------------------

export interface JavaThrowable {
  type: string;
  message: string;
  frames: string[];
  /** Printed as `... N common frames omitted` after the frames (for causes). */
  omitted?: number;
}

export function javaStack(top: JavaThrowable, ...causes: JavaThrowable[]): string {
  const render = (t: JavaThrowable, prefix: string) => {
    const lines = [`${prefix}${t.type}: ${t.message}`, ...t.frames.map((f) => `\tat ${f}`)];
    if (t.omitted) lines.push(`\t... ${t.omitted} common frames omitted`);
    return lines.join('\n');
  };
  return [render(top, ''), ...causes.map((c) => render(c, 'Caused by: '))].join('\n');
}

type HttpVerb = 'GET' | 'POST' | 'PUT';

/** Frames below a Spring MVC controller method (Spring 6.1, Tomcat 10.1, Java 21). */
export function springMvcFrames(verb: HttpVerb): string[] {
  const servlet = {
    GET: ['doGet(FrameworkServlet.java:903)', 'HttpServlet.java:564'],
    POST: ['doPost(FrameworkServlet.java:914)', 'HttpServlet.java:590'],
    PUT: ['doPut(FrameworkServlet.java:925)', 'HttpServlet.java:600'],
  }[verb];
  return [
    'java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
    'java.base/java.lang.reflect.Method.invoke(Method.java:580)',
    'org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:255)',
    'org.springframework.web.method.support.InvocableHandlerMethod.invokeForRequest(InvocableHandlerMethod.java:188)',
    'org.springframework.web.servlet.mvc.method.annotation.ServletInvocableHandlerMethod.invokeAndHandle(ServletInvocableHandlerMethod.java:118)',
    'org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter.invokeHandlerMethod(RequestMappingHandlerAdapter.java:926)',
    'org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter.handleInternal(RequestMappingHandlerAdapter.java:831)',
    'org.springframework.web.servlet.mvc.method.AbstractHandlerMethodAdapter.handle(AbstractHandlerMethodAdapter.java:87)',
    'org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1089)',
    'org.springframework.web.servlet.DispatcherServlet.doService(DispatcherServlet.java:979)',
    'org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)',
    `org.springframework.web.servlet.FrameworkServlet.${servlet[0]}`,
    `jakarta.servlet.http.HttpServlet.service(${servlet[1]})`,
    'org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)',
    'jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)',
    'org.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:195)',
    'org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:140)',
    'org.springframework.security.web.FilterChainProxy.doFilterInternal(FilterChainProxy.java:233)',
    'org.springframework.security.web.FilterChainProxy.doFilter(FilterChainProxy.java:191)',
    'org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)',
    'org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:167)',
    'org.apache.catalina.core.StandardContextValve.invoke(StandardContextValve.java:90)',
    'org.apache.catalina.core.StandardHostValve.invoke(StandardHostValve.java:115)',
    'org.apache.catalina.core.StandardEngineValve.invoke(StandardEngineValve.java:74)',
    'org.apache.catalina.connector.CoyoteAdapter.service(CoyoteAdapter.java:344)',
    'org.apache.coyote.http11.Http11Processor.service(Http11Processor.java:391)',
    'org.apache.coyote.AbstractProcessorLight.process(AbstractProcessorLight.java:63)',
    'org.apache.coyote.AbstractProtocol$ConnectionHandler.process(AbstractProtocol.java:896)',
    'org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1744)',
    'org.apache.tomcat.util.net.SocketProcessorBase.run(SocketProcessorBase.java:52)',
    'org.apache.tomcat.util.threads.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1191)',
    'org.apache.tomcat.util.threads.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:659)',
    'org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run(TaskThread.java:63)',
    'java.base/java.lang.Thread.run(Thread.java:1583)',
  ];
}

/** Frames of a call through a Spring AOP (e.g. `@Transactional`) CGLIB proxy. */
export function springProxyFrames(cls: string, method: string): string[] {
  return [
    'org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(ReflectiveMethodInvocation.java:184)',
    'org.springframework.transaction.interceptor.TransactionInterceptor$1.proceedWithInvocation(TransactionInterceptor.java:123)',
    'org.springframework.transaction.interceptor.TransactionAspectSupport.invokeWithinTransaction(TransactionAspectSupport.java:392)',
    'org.springframework.transaction.interceptor.TransactionInterceptor.invoke(TransactionInterceptor.java:119)',
    'org.springframework.aop.framework.ReflectiveMethodInvocation.proceed(ReflectiveMethodInvocation.java:184)',
    'org.springframework.aop.framework.CglibAopProxy$DynamicAdvisedInterceptor.intercept(CglibAopProxy.java:720)',
    `${cls}$$SpringCGLIB$$0.${method}(<generated>)`,
  ];
}

/** Frames below a Spring Kafka batch `@KafkaListener` method (spring-kafka 3.3). */
export function springKafkaBatchFrames(): string[] {
  return [
    'java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
    'java.base/java.lang.reflect.Method.invoke(Method.java:580)',
    'org.springframework.messaging.handler.invocation.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:169)',
    'org.springframework.messaging.handler.invocation.InvocableHandlerMethod.invoke(InvocableHandlerMethod.java:119)',
    'org.springframework.kafka.listener.adapter.HandlerAdapter.invoke(HandlerAdapter.java:70)',
    'org.springframework.kafka.listener.adapter.MessagingMessageListenerAdapter.invokeHandler(MessagingMessageListenerAdapter.java:420)',
    'org.springframework.kafka.listener.adapter.BatchMessagingMessageListenerAdapter.invoke(BatchMessagingMessageListenerAdapter.java:180)',
    'org.springframework.kafka.listener.adapter.BatchMessagingMessageListenerAdapter.onMessage(BatchMessagingMessageListenerAdapter.java:172)',
    'org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.doInvokeBatchOnMessage(KafkaMessageListenerContainer.java:2392)',
    'org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.invokeBatchListener(KafkaMessageListenerContainer.java:2165)',
    'org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.invokeListener(KafkaMessageListenerContainer.java:2120)',
    'org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.pollAndInvoke(KafkaMessageListenerContainer.java:1569)',
    'org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.run(KafkaMessageListenerContainer.java:1395)',
    'java.base/java.util.concurrent.CompletableFuture$AsyncRun.run(CompletableFuture.java:1804)',
    'java.base/java.lang.Thread.run(Thread.java:1583)',
  ];
}

/** `com.keybank.pay.client.CustomerProfileClient.getProfile(CustomerProfileClient.java:52)` */
export function javaFrame(fqcn: string, method: string, line: number): string {
  const simple = fqcn.split('.').pop()!.split('$')[0]!;
  return `${fqcn}.${method}(${simple}.java:${line})`;
}

// ---------------------------------------------------------------------------
// Node (source-mapped, `node --enable-source-maps`) and Python tracebacks
// ---------------------------------------------------------------------------

export function nodeFrame(fn: string, path: string, at: { line: number; col: number }): string {
  return `    at ${fn} (/app/${path}:${at.line}:${at.col})`;
}

/** Fastify request id (`req-1a2b`). */
export function reqId(ctx: LogContext): string {
  return `req-${ctx.rng.int(1, 1_679_615).toString(36)}`;
}

export const NODE_TICKS =
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)';

export interface PyFrame {
  path: string;
  content: string;
  /** Text identifying the line in `content`. */
  needle: string;
  fn: string;
  /** Substring of the line to underline with carets (Python 3.12 style). */
  highlight?: { text: string; subscript?: boolean };
}

export function pyTraceback(frames: PyFrame[], exception: string): string {
  const out = ['Traceback (most recent call last):'];
  for (const f of frames) {
    const line = sourceLine(f.content, f.needle);
    out.push(`  File "/app/${f.path}", line ${lineOf(f.content, f.needle)}, in ${f.fn}`);
    const trimmed = line.trimStart();
    out.push(`    ${trimmed}`);
    if (f.highlight) {
      const start = trimmed.indexOf(f.highlight.text);
      if (start >= 0) {
        const pad = ' '.repeat(4 + start);
        if (f.highlight.subscript) {
          const bracket = f.highlight.text.indexOf('[');
          out.push(`${pad}${'~'.repeat(bracket)}${'^'.repeat(f.highlight.text.length - bracket)}`);
        } else {
          out.push(`${pad}${'^'.repeat(f.highlight.text.length)}`);
        }
      }
    }
  }
  out.push(exception);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// YAML / text predicates used by fix detectors
// ---------------------------------------------------------------------------

/** Drops `#` comments (YAML / properties) so predicates ignore commented-out lines. */
export function stripHashComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

/** Drops `//` line comments and block comments (Java / TS). */
export function stripCComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// Moogsoft events
// ---------------------------------------------------------------------------

export interface AlertSpec {
  atSec: number;
  repeatEverySec?: number;
  tla: string;
  severity: AlertSeverity;
  manager: AlertManager;
  check: string;
  description: string;
  /** Defaults to `Application`. */
  cls?: string;
  /** Defaults to the service's cluster DNS name. */
  source?: string;
  custom?: Record<string, string | number | boolean>;
}

/** A Moogsoft event on an app's primary service, with a dedupe key stable per check. */
export function moogsoftAlert(spec: AlertSpec): ScenarioAlert {
  const app = getApp(spec.tla);
  const { service, namespace, cluster, gcpProject } = app.runtime;
  const manager = spec.manager.toLowerCase().replace(/\s+/g, '-');
  return {
    atSec: spec.atSec,
    repeatEverySec: spec.repeatEverySec,
    alert: {
      severity: spec.severity,
      description: spec.description,
      source: spec.source ?? `${service}.${namespace}.svc.cluster.local`,
      service,
      app_tla: app.tla,
      manager: spec.manager,
      class: spec.cls ?? 'Application',
      check: spec.check,
      dedupe_key: `${manager}:${app.tla}:${service}:${spec.check}`,
      custom_info: { gcp_project: gcpProject, cluster, namespace, ...spec.custom },
    },
  };
}
