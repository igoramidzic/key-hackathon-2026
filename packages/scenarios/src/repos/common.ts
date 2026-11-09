/** Shared builders for hero repo boilerplate. */

export interface PomOptions {
  tla: string;
  artifactId: string;
  version: string;
  description: string;
  /** Extra `<dependency>` blocks (already indented by 4 spaces). */
  extraDependencies?: string[];
}

const dep = (groupId: string, artifactId: string, extra = '') =>
  `    <dependency>
      <groupId>${groupId}</groupId>
      <artifactId>${artifactId}</artifactId>${extra}
    </dependency>`;

/** Spring Boot 3.4 / Java 21 service pom. */
export function springPom(o: PomOptions): string {
  const deps = [
    dep('org.springframework.boot', 'spring-boot-starter-web'),
    dep('org.springframework.boot', 'spring-boot-starter-validation'),
    dep('org.springframework.boot', 'spring-boot-starter-data-jpa'),
    dep('org.springframework.boot', 'spring-boot-starter-oauth2-resource-server'),
    dep('org.springframework.boot', 'spring-boot-starter-actuator'),
    dep('io.micrometer', 'micrometer-registry-prometheus'),
    dep('org.flywaydb', 'flyway-database-postgresql'),
    dep('org.postgresql', 'postgresql', '\n      <scope>runtime</scope>'),
    ...(o.extraDependencies ?? []),
    dep('org.springframework.boot', 'spring-boot-starter-test', '\n      <scope>test</scope>'),
    dep('org.springframework.security', 'spring-security-test', '\n      <scope>test</scope>'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.4</version>
    <relativePath/>
  </parent>

  <groupId>com.keybank.${o.tla.toLowerCase()}</groupId>
  <artifactId>${o.artifactId}</artifactId>
  <version>${o.version}</version>
  <name>${o.artifactId}</name>
  <description>${o.description}</description>

  <properties>
    <java.version>21</java.version>
  </properties>

  <dependencies>
${deps.join('\n')}
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <configuration>
          <argLine>-XX:+EnableDynamicAgentLoading</argLine>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

export const NODE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
`;

/** package.json for a Fastify service bundled with esbuild (source maps on in prod). */
export function nodePackageJson(o: {
  name: string;
  version: string;
  description: string;
  dependencies: Record<string, string>;
}): string {
  const deps = Object.entries(o.dependencies)
    .map(([k, v]) => `    "${k}": "${v}"`)
    .join(',\n');
  return `{
  "name": "${o.name}",
  "version": "${o.version}",
  "private": true,
  "description": "${o.description}",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --sourcemap --packages=external --outfile=dist/index.js",
    "start": "node --enable-source-maps dist/index.js",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
${deps}
  },
  "devDependencies": {
    "@types/node": "22.9.0",
    "esbuild": "0.24.0",
    "tsx": "4.19.2",
    "typescript": "5.6.3",
    "vitest": "2.1.4"
  }
}
`;
}
