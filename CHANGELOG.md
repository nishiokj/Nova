# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Production readiness improvements
- Comprehensive test coverage with 80% threshold
- CI/CD pipeline with GitHub Actions
- Performance benchmarks in `benchmarks/`
- Memory profiling script in `scripts/profile_memory.py`
- Centralized exception hierarchy in `src/util/exceptions.py`
- Correlation IDs for cross-process request tracing
- CLI integration tests
- Error recovery tests
- Release workflow for PyPI publication

### Changed
- Pinned all dependencies with upper bounds for stability
- Updated error handling with custom exception hierarchy
- Enhanced structured logging with correlation ID support
- Improved pytest configuration with coverage enforcement

### Removed
- Removed empty `run_single.py`
- Removed malformed `config.json`
- Cleaned up unused imports and dead code

### Fixed
- Fixed backspace bug in TypeScript TUI
- Removed unreachable code in agent adapter
- Fixed unused variable warnings

### Security
- Added bandit security scanning to CI
- Added pip-audit for dependency vulnerability scanning

## [0.1.0] - 2024-12-31

### Added
- Initial release
- Multi-process voice agent architecture
- Plan -> Execute -> Reflect agent loop
- STT support (Whisper, Google, Azure)
- TTS support (pyttsx3, ElevenLabs)
- Tool registry with 20+ built-in tools
- Wizard orchestration mode (experimental)
- Graphd repository graph daemon
- Evaluation framework with LLM-as-judge
- CLI interface with multiple commands
- TUI interfaces (Python curses, TypeScript Ink)
- Docker support
- Comprehensive configuration system

### Known Issues
- TODOs for Phase 5 advanced features (context injection) pending
- TODOs for Phase 8 migration (ProcessManager) pending
- Parallel execution in multiturn runner not yet implemented

[Unreleased]: https://github.com/nishiokj/rex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nishiokj/rex/releases/tag/v0.1.0
