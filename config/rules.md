# Default Rules

These are sensible defaults that can be overridden by repository-specific rules in `repository.md`.

## Package Managers
- Always use bun for TypeScript/JavaScript applications when available
- Always use uv for Python projects when available
- Prefer pnpm over npm if bun is not available

## Styling
- Prefer Tailwind CSS for styling in new projects
- Use CSS modules for component-scoped styles

## Code Quality
- Prefer TypeScript over JavaScript for new files
- Use strict mode in TypeScript configurations
- Prefer functional components over class components in React

## Testing
- Write tests for new functionality
- Prefer vitest for JavaScript/TypeScript testing
- Use pytest for Python testing

## General
- Follow existing code conventions in the repository
- Keep functions small and focused
- Prefer composition over inheritance
