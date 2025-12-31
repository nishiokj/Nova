# Contributing to rex

Thank you for your interest in contributing to rex!

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/nishiokj/rex.git
   cd rex
   ```

2. Create virtual environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # or `.venv\Scripts\activate` on Windows
   ```

3. Install development dependencies:
   ```bash
   pip install -e ".[dev]"
   ```

4. Install pre-commit hooks:
   ```bash
   pre-commit install
   ```

## Running Tests

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html

# Run specific test file
pytest tests/test_agent.py

# Run specific test
pytest tests/test_agent.py::test_agent_initialization

# Skip slow tests
pytest -m "not slow"

# Run benchmarks
pytest benchmarks/ -m benchmark
```

## Code Style

We use the following tools for code quality:

- **black** - Code formatting
- **isort** - Import sorting
- **ruff** - Linting
- **mypy** - Type checking

Run all checks:
```bash
black src/ tests/
isort src/ tests/
ruff check src/ tests/
mypy src/
```

Or use pre-commit to run all checks automatically:
```bash
pre-commit run --all-files
```

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit:
   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

3. Push and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Ensure CI passes before requesting review.

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `style:` - Formatting
- `refactor:` - Code restructuring
- `test:` - Tests
- `chore:` - Maintenance
- `perf:` - Performance improvement
- `ci:` - CI/CD changes

Examples:
```
feat: add voice activity detection improvements
fix: resolve audio buffer overflow on high sample rates
docs: update README with installation instructions
refactor: simplify tool registry lookup
test: add integration tests for CLI commands
```

## Code Guidelines

### General
- Line length: 100 characters
- Use type hints throughout
- Write docstrings for public APIs
- Keep functions focused and small

### Testing
- Write tests for new features
- Maintain test coverage above 80%
- Use pytest fixtures for common setup
- Mark slow tests with `@pytest.mark.slow`

### Error Handling
- Use custom exceptions from `util.exceptions`
- Log errors with structured logging
- Include correlation IDs for traceability

### Dependencies
- Keep dependencies minimal
- Use version bounds (e.g., `>=1.0.0,<2.0.0`)
- Update lockfiles when changing dependencies

## Reporting Issues

Please include:
- Python version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs/error messages

## Security Issues

For security vulnerabilities, please email the maintainers directly instead of opening a public issue.

## Questions?

Open a discussion on GitHub or reach out to the maintainers.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
