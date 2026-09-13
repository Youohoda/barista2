// Universal Project Detection Engine.
//
// Takes the files already uploaded to a Project's workspace (WorkspaceFile rows —
// name + content, whatever the user actually uploaded/pasted) and detects language,
// framework, runtime, build system, package manager, database and test framework
// from real signatures in those files: manifest contents (package.json deps,
// requirements.txt, Cargo.toml, go.mod, *.csproj, Gemfile, composer.json), config
// file presence (next.config.*, vite.config.*, angular.json), and structural
// conventions (Roblox's init.server.lua / init.client.lua, Discord.js's discord.js
// dependency). Nothing here is hardcoded to Barista or to "one true stack" — it's a
// registry of independent detectors, each free to fire or not, so adding support for
// a new ecosystem is one more entry, not a rewrite (this is the "Extensible instead
// of a rigid list" requirement).
//
// Deliberately a pure function with no I/O: callers (api/projects.js) load the files
// from Mongo and pass them in, so this module is trivially unit-testable and has zero
// chance of silently depending on request/response objects.

/** @typedef {{name: string, content: string}} DetInputFile */

function findFile(files, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(`(^|/)${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return files.find(f => re.test(f.name));
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function depsOf(pkgJson) {
  if (!pkgJson) return {};
  return { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
}

// Each detector returns null if it doesn't match, or a partial result with a
// `confidence` (0-1) if it does. Detectors run independently; results are merged
// by field, highest confidence per field wins (see detectProject below), so a
// Node.js project can be detected as "runtime: node" by one detector and
// "framework: discord.js" by another without either overriding the other's field.
const detectors = [
  // --- Node.js ecosystem, disambiguated by package.json dependencies ---
  {
    id: 'node-package-json',
    detect(files) {
      const pkgFile = findFile(files, 'package.json');
      if (!pkgFile) return null;
      const pkg = safeJSON(pkgFile.content);
      if (!pkg) return null;
      const deps = depsOf(pkg);
      const depNames = Object.keys(deps);
      const has = (name) => depNames.includes(name);

      let framework = null, type = 'Node.js Project';
      if (has('discord.js')) { framework = 'discord.js'; type = 'Discord Bot'; }
      else if (has('next')) { framework = 'Next.js'; type = 'Next.js App'; }
      else if (has('react') && has('react-dom') && !has('next')) { framework = 'React'; type = 'React App'; }
      else if (has('vue')) { framework = 'Vue'; type = 'Vue App'; }
      else if (has('@angular/core')) { framework = 'Angular'; type = 'Angular App'; }
      else if (has('svelte')) { framework = 'Svelte'; type = 'Svelte App'; }
      else if (has('express')) { framework = 'Express'; type = 'Node.js API'; }
      else if (has('fastify')) { framework = 'Fastify'; type = 'Node.js API'; }
      else if (has('@nestjs/core')) { framework = 'NestJS'; type = 'Node.js API'; }

      let database = null;
      if (has('mongoose') || has('mongodb')) database = 'MongoDB';
      else if (has('pg') || has('sequelize') || has('prisma')) database = has('pg') ? 'PostgreSQL' : 'SQL (via ORM)';
      else if (has('mysql') || has('mysql2')) database = 'MySQL';
      else if (has('redis') || has('ioredis')) database = 'Redis';

      const testFramework = has('jest') ? 'Jest' : has('vitest') ? 'Vitest' : has('mocha') ? 'Mocha'
        : (pkg.scripts && /node --test|node:test/.test(JSON.stringify(pkg.scripts))) ? 'node:test' : null;

      return {
        language: 'JavaScript/TypeScript',
        runtime: 'Node.js',
        framework, type, database, testFramework,
        packageManager: findFile(files, 'pnpm-lock.yaml') ? 'pnpm' : findFile(files, 'yarn.lock') ? 'yarn' : 'npm',
        buildSystem: pkg.scripts?.build ? 'npm run build' : null,
        dependencies: depNames.slice(0, 40),
        confidence: 0.9
      };
    }
  },
  // --- Roblox: no manifest, detected from structural Lua conventions instead ---
  {
    id: 'roblox-lua',
    detect(files) {
      const luaFiles = files.filter(f => /\.lua$/i.test(f.name));
      if (!luaFiles.length) return null;
      const hasRobloxConvention = luaFiles.some(f =>
        /init\.(server|client)\.lua$/i.test(f.name) ||
        /\bgame:GetService\(/.test(f.content) ||
        /\bworkspace\./.test(f.content)
      );
      if (!hasRobloxConvention) {
        // Plain Lua project (e.g. a Lua CLI tool), not Roblox specifically.
        return { language: 'Lua', type: 'Lua Project', confidence: 0.5 };
      }
      return { language: 'Lua', runtime: 'Roblox', type: 'Roblox Game', framework: 'Roblox', confidence: 0.85 };
    }
  },
  // --- Python ---
  {
    id: 'python',
    detect(files) {
      const req = findFile(files, 'requirements.txt');
      const pyproject = findFile(files, 'pyproject.toml');
      const hasPy = files.some(f => /\.py$/i.test(f.name));
      if (!req && !pyproject && !hasPy) return null;
      const text = `${req?.content || ''}\n${pyproject?.content || ''}`.toLowerCase();
      let framework = null, type = 'Python Project';
      if (/\bdjango\b/.test(text)) { framework = 'Django'; type = 'Django App'; }
      else if (/\bfastapi\b/.test(text)) { framework = 'FastAPI'; type = 'FastAPI Service'; }
      else if (/\bflask\b/.test(text)) { framework = 'Flask'; type = 'Flask App'; }
      else if (/\bdiscord\.py\b/.test(text)) { framework = 'discord.py'; type = 'Discord Bot'; }

      let database = null;
      if (/\bpsycopg2?\b|\bpostgres\b/.test(text)) database = 'PostgreSQL';
      else if (/\bpymongo\b/.test(text)) database = 'MongoDB';
      else if (/\bmysqlclient\b|\bpymysql\b/.test(text)) database = 'MySQL';

      return {
        language: 'Python', runtime: 'Python', framework, type, database,
        testFramework: /\bpytest\b/.test(text) ? 'pytest' : (files.some(f => /^test_.*\.py$|_test\.py$/i.test(f.name)) ? 'unittest' : null),
        packageManager: pyproject ? 'poetry/pip' : 'pip',
        buildSystem: pyproject ? 'pyproject.toml' : null,
        confidence: req || pyproject ? 0.85 : 0.6
      };
    }
  },
  // --- Go ---
  {
    id: 'go',
    detect(files) {
      const mod = findFile(files, 'go.mod');
      if (!mod) return null;
      const moduleMatch = mod.content.match(/^module\s+(\S+)/m);
      return {
        language: 'Go', runtime: 'Go', type: 'Go Project',
        packageManager: 'go modules', buildSystem: 'go build',
        testFramework: 'go test',
        dependencies: moduleMatch ? [moduleMatch[1]] : [],
        confidence: 0.9
      };
    }
  },
  // --- Rust ---
  {
    id: 'rust',
    detect(files) {
      const cargo = findFile(files, 'Cargo.toml');
      if (!cargo) return null;
      let framework = null;
      if (/\bactix-web\b/.test(cargo.content)) framework = 'actix-web';
      else if (/\baxum\b/.test(cargo.content)) framework = 'axum';
      else if (/\brocket\b/i.test(cargo.content)) framework = 'Rocket';
      return {
        language: 'Rust', runtime: 'Rust', type: framework ? 'Rust Web Service' : 'Rust Project',
        framework, packageManager: 'cargo', buildSystem: 'cargo build', testFramework: 'cargo test',
        confidence: 0.9
      };
    }
  },
  // --- Java (Maven / Gradle) ---
  {
    id: 'java',
    detect(files) {
      const pom = findFile(files, 'pom.xml');
      const gradle = findFile(files, /build\.gradle(\.kts)?$/);
      if (!pom && !gradle) return null;
      const text = (pom?.content || gradle?.content || '');
      return {
        language: 'Java', runtime: 'JVM', type: /spring-boot/i.test(text) ? 'Spring Boot App' : 'Java Project',
        framework: /spring-boot/i.test(text) ? 'Spring Boot' : null,
        packageManager: pom ? 'Maven' : 'Gradle', buildSystem: pom ? 'mvn' : 'gradle',
        testFramework: /junit/i.test(text) ? 'JUnit' : null,
        confidence: 0.85
      };
    }
  },
  // --- C# / .NET ---
  {
    id: 'dotnet',
    detect(files) {
      const csproj = findFile(files, /\.csproj$/);
      if (!csproj) return null;
      return {
        language: 'C#', runtime: '.NET', type: /Microsoft\.AspNetCore/i.test(csproj.content) ? 'ASP.NET App' : '.NET Project',
        framework: /Microsoft\.AspNetCore/i.test(csproj.content) ? 'ASP.NET Core' : null,
        packageManager: 'NuGet', buildSystem: 'dotnet build', testFramework: 'dotnet test',
        confidence: 0.85
      };
    }
  },
  // --- PHP ---
  {
    id: 'php',
    detect(files) {
      const composer = findFile(files, 'composer.json');
      if (!composer) return null;
      const pkg = safeJSON(composer.content);
      const deps = { ...(pkg?.require || {}), ...(pkg?.['require-dev'] || {}) };
      const names = Object.keys(deps);
      const framework = names.some(n => n.startsWith('laravel/')) ? 'Laravel'
        : names.some(n => n.startsWith('symfony/')) ? 'Symfony' : null;
      return {
        language: 'PHP', runtime: 'PHP', type: framework ? `${framework} App` : 'PHP Project',
        framework, packageManager: 'Composer',
        testFramework: names.includes('phpunit/phpunit') ? 'PHPUnit' : null,
        confidence: 0.85
      };
    }
  },
  // --- Ruby ---
  {
    id: 'ruby',
    detect(files) {
      const gemfile = findFile(files, 'Gemfile');
      if (!gemfile) return null;
      const isRails = /\brails\b/i.test(gemfile.content);
      return {
        language: 'Ruby', runtime: 'Ruby', type: isRails ? 'Rails App' : 'Ruby Project',
        framework: isRails ? 'Rails' : null, packageManager: 'Bundler',
        testFramework: /\brspec\b/i.test(gemfile.content) ? 'RSpec' : null,
        confidence: 0.85
      };
    }
  },
  // --- Static / plain HTML-CSS-JS site (fallback signal, low confidence) ---
  {
    id: 'static-web',
    detect(files) {
      const hasIndexHtml = findFile(files, 'index.html');
      const hasManifest = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json', 'Gemfile', 'pom.xml']
        .some(m => findFile(files, m));
      if (!hasIndexHtml || hasManifest) return null;
      return { language: 'HTML/CSS/JS', type: 'Static Website', runtime: 'Browser', confidence: 0.4 };
    }
  }
];

/**
 * Run every detector against the given files and merge their results.
 * @param {DetInputFile[]} files
 * @returns {{
 *   type: ?string, language: ?string, framework: ?string, runtime: ?string,
 *   database: ?string, buildSystem: ?string, packageManager: ?string,
 *   testFramework: ?string, dependencies: string[], confidence: number,
 *   matchedDetectors: string[], detectedAt: Date
 * }}
 */
export function detectProject(files) {
  const list = Array.isArray(files) ? files.filter(f => f && typeof f.name === 'string') : [];
  const merged = {
    type: null, language: null, framework: null, runtime: null, database: null,
    buildSystem: null, packageManager: null, testFramework: null, dependencies: []
  };
  const fieldConfidence = {};
  const matched = [];

  if (!list.length) {
    return { ...merged, confidence: 0, matchedDetectors: [], detectedAt: new Date() };
  }

  for (const detector of detectors) {
    let result;
    try { result = detector.detect(list); } catch { result = null; } // one bad detector must never break the rest
    if (!result) continue;
    matched.push(detector.id);
    const conf = result.confidence ?? 0.5;
    for (const key of Object.keys(merged)) {
      if (key === 'dependencies') {
        if (Array.isArray(result.dependencies) && result.dependencies.length) merged.dependencies = result.dependencies;
        continue;
      }
      if (result[key] == null) continue;
      // Field-level "highest confidence wins" so, e.g., a Discord.js detector's
      // `framework` doesn't get silently overwritten by a lower-confidence static
      // fallback that happens to run after it in the registry.
      if (fieldConfidence[key] === undefined || conf > fieldConfidence[key]) {
        merged[key] = result[key];
        fieldConfidence[key] = conf;
      }
    }
  }

  const overallConfidence = matched.length
    ? Math.max(...Object.values(fieldConfidence))
    : 0;

  return { ...merged, confidence: overallConfidence, matchedDetectors: matched, detectedAt: new Date() };
}

// Exposed so new detectors can be registered by other modules without editing this
// file's internals — e.g. a future user-supplied detector plugin.
export function registerDetector(detector) {
  if (!detector || typeof detector.detect !== 'function' || !detector.id) {
    throw new Error('detector يجب أن يكون { id, detect(files) }');
  }
  if (detectors.some(d => d.id === detector.id)) return; // idempotent re-registration
  detectors.push(detector);
}

export const _detectors = detectors; // exported for tests only
