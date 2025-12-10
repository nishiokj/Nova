# React + TypeScript + Vite Starter

This repository is a minimal, runnable starter scaffold for a React app using TypeScript and Vite.

Files created

- package.json - project manifest and scripts
- index.html - Vite entry HTML
- vite.config.ts - Vite config with React plugin
- tsconfig.json - TypeScript configuration
- src/main.tsx - React entrypoint
- src/app.tsx - Main React component (TypeScript)
- src/styles.css - Basic styles
- .eslintrc.json - ESLint configuration
- .prettierrc - Prettier configuration
- .gitignore - sensible defaults
- README.md - this file

Quick start

1. Install dependencies

   npm install

2. Run the dev server

   npm run dev

   The default Vite server runs on http://localhost:5173. Open that URL in your browser.

3. Build for production

   npm run build

4. Preview the production build locally

   npm run preview

Helpful scripts

- npm run dev — start development server
- npm run build — create production build (output: dist)
- npm run preview — locally preview the production build
- npm run typecheck — run TypeScript type checking (noEmit)
- npm run lint — run ESLint (requires node modules to be installed)
- npm run format — run Prettier to format files

Notes

- Recommended Node.js version: 16.x or newer
- If you add TypeScript-aware linting with @typescript-eslint, install the parser and plugin packages and update .eslintrc.json accordingly.

Customization

Replace src/app.tsx with your application components and add routing/state management as needed.

License

MIT
