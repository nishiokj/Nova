#!/usr/bin/env bun
/**
 * Project Scaffold CLI for design-fork skill.
 *
 * Generates a React + Vite + TypeScript project from a DesignSpec JSON.
 *
 * Usage:
 *   bun run scripts/scaffold.ts --spec design-spec.json --output packages/my-app
 *   bun run scripts/scaffold.ts --name "My App" --aesthetic dark-glass --palette zinc --output packages/my-app
 *
 * Output: JSON with created file paths.
 */

import { writeFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { parseArgs } from 'util';
import { getPalette, getTypography } from '../lib/palettes.js';
import { getAesthetic } from '../lib/aesthetics.js';

interface DesignSpec {
  meta: {
    id: string;
    name: string;
    description: string;
    aesthetic: string;
    palette: string;
  };
  theme: {
    colors: Record<string, string>;
    typography: {
      headingFont: string;
      bodyFont: string;
      monoFont: string;
    };
    spacing: Record<string, string>;
    borderRadius: string;
  };
  components: string[];
  pages: string[];
}

interface Output {
  success: boolean;
  outputDir?: string;
  files?: string[];
  error?: string;
}

function generatePackageJson(name: string): string {
  const pkgName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return JSON.stringify(
    {
      name: pkgName,
      private: true,
      version: '0.0.1',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc && vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
      },
      devDependencies: {
        '@types/react': '^18.2.0',
        '@types/react-dom': '^18.2.0',
        '@vitejs/plugin-react': '^4.2.0',
        typescript: '^5.3.0',
        vite: '^5.0.0',
      },
    },
    null,
    2
  );
}

function generateTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ['src'],
    },
    null,
    2
  );
}

function generateViteConfig(): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;
}

function generateIndexHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function generateMainTsx(): string {
  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
}

function generateAppTsx(): string {
  return `import { MainLayout } from './layouts/MainLayout';
import { HomePage } from './pages/HomePage';

function App() {
  return (
    <MainLayout>
      <HomePage />
    </MainLayout>
  );
}

export default App;
`;
}

function generateTokensCss(colors: Record<string, string>, typography: DesignSpec['theme']['typography']): string {
  const colorVars = Object.entries(colors)
    .map(([key, value]) => `  --color-${key}: ${value};`)
    .join('\n');

  return `:root {
  /* Colors */
${colorVars}

  /* Typography */
  --font-heading: ${typography.headingFont};
  --font-body: ${typography.bodyFont};
  --font-mono: ${typography.monoFont};

  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2rem;
  --spacing-2xl: 3rem;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;
}
`;
}

function generateGlobalsCss(): string {
  return `*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  font-family: var(--font-body);
  background-color: var(--color-background);
  color: var(--color-text);
  line-height: 1.5;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 600;
  line-height: 1.2;
}

code, pre {
  font-family: var(--font-mono);
}

a {
  color: var(--color-primary);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
`;
}

function generateMainLayout(): string {
  return `import { ReactNode } from 'react';

interface MainLayoutProps {
  children: ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="layout">
      <header className="header">
        <h1>App Name</h1>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
`;
}

function generateHomePage(): string {
  return `export function HomePage() {
  return (
    <div className="page home-page">
      <h2>Welcome</h2>
      <p>This is a scaffolded project from design-fork.</p>
    </div>
  );
}
`;
}

function generateComponentStub(name: string): string {
  const componentName = name.charAt(0).toUpperCase() + name.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return `interface ${componentName}Props {
  // Add props here
}

export function ${componentName}({}: ${componentName}Props) {
  return (
    <div className="${name}">
      {/* ${componentName} component */}
    </div>
  );
}
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string', short: 's' },
      name: { type: 'string', short: 'n' },
      aesthetic: { type: 'string', short: 'a' },
      palette: { type: 'string', short: 'p' },
      output: { type: 'string', short: 'o' },
      reference: { type: 'string', short: 'r' },
    },
    strict: true,
  });

  if (!values.output) {
    const output: Output = { success: false, error: 'Missing required --output argument' };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  const outputDir = values.output;
  const createdFiles: string[] = [];

  // Build spec from arguments or load from file
  let spec: DesignSpec;

  if (values.spec && existsSync(values.spec)) {
    const specContent = await Bun.file(values.spec).text();
    spec = JSON.parse(specContent);
  } else {
    // Build from arguments
    const name = values.name ?? 'My App';
    const aestheticId = values.aesthetic ?? 'dark-glass';
    const paletteId = values.palette ?? 'zinc';

    const aesthetic = getAesthetic(aestheticId);
    const palette = getPalette(paletteId);
    const typography = getTypography('modern');

    if (!palette || !typography) {
      const output: Output = { success: false, error: 'Invalid palette or typography' };
      console.log(JSON.stringify(output));
      process.exit(1);
    }

    spec = {
      meta: {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name,
        description: `Generated from ${aestheticId} aesthetic`,
        aesthetic: aestheticId,
        palette: paletteId,
      },
      theme: {
        colors: {
          primary: palette.primary,
          secondary: palette.secondary,
          accent: palette.accent,
          background: palette.background,
          surface: palette.surface,
          text: palette.text,
          'text-muted': palette.textMuted,
          border: palette.border,
          success: palette.success,
          warning: palette.warning,
          error: palette.error,
        },
        typography: {
          headingFont: typography.headingFont,
          bodyFont: typography.bodyFont,
          monoFont: typography.monoFont,
        },
        spacing: {
          xs: '0.25rem',
          sm: '0.5rem',
          md: '1rem',
          lg: '1.5rem',
          xl: '2rem',
        },
        borderRadius: '8px',
      },
      components: ['button', 'card', 'input'],
      pages: ['home'],
    };
  }

  // Create directory structure
  const dirs = [
    outputDir,
    join(outputDir, 'src'),
    join(outputDir, 'src/components'),
    join(outputDir, 'src/pages'),
    join(outputDir, 'src/layouts'),
    join(outputDir, 'src/styles'),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  // Write files
  const files: Array<{ path: string; content: string }> = [
    { path: join(outputDir, 'package.json'), content: generatePackageJson(spec.meta.name) },
    { path: join(outputDir, 'tsconfig.json'), content: generateTsConfig() },
    { path: join(outputDir, 'vite.config.ts'), content: generateViteConfig() },
    { path: join(outputDir, 'index.html'), content: generateIndexHtml(spec.meta.name) },
    { path: join(outputDir, 'design-spec.json'), content: JSON.stringify(spec, null, 2) },
    { path: join(outputDir, 'src/main.tsx'), content: generateMainTsx() },
    { path: join(outputDir, 'src/App.tsx'), content: generateAppTsx() },
    { path: join(outputDir, 'src/styles/tokens.css'), content: generateTokensCss(spec.theme.colors, spec.theme.typography) },
    { path: join(outputDir, 'src/styles/globals.css'), content: generateGlobalsCss() },
    { path: join(outputDir, 'src/layouts/MainLayout.tsx'), content: generateMainLayout() },
    { path: join(outputDir, 'src/pages/HomePage.tsx'), content: generateHomePage() },
  ];

  // Generate component stubs
  for (const component of spec.components) {
    files.push({
      path: join(outputDir, `src/components/${component}.tsx`),
      content: generateComponentStub(component),
    });
  }

  for (const file of files) {
    await writeFile(file.path, file.content);
    createdFiles.push(file.path);
    console.error(`Created: ${file.path}`);
  }

  // Copy reference image if provided
  if (values.reference && existsSync(values.reference)) {
    const refPath = join(outputDir, 'reference.png');
    await copyFile(values.reference, refPath);
    createdFiles.push(refPath);
    console.error(`Copied: ${refPath}`);
  }

  const output: Output = {
    success: true,
    outputDir,
    files: createdFiles,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const output: Output = { success: false, error: error.message };
  console.log(JSON.stringify(output));
  process.exit(1);
});
