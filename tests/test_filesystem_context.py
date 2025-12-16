from harness.context_manager import FilesystemContext


def test_filesystem_context_does_not_auto_include_readme_requirements_or_envexample(tmp_path):
    (tmp_path / "README.md").write_text("# Hello\n\nThis should not be auto-included.\n")
    (tmp_path / "requirements.txt").write_text("requests==2.0.0\n")
    (tmp_path / ".env.example").write_text("EXAMPLE=1\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n")

    fs = FilesystemContext(str(tmp_path))
    ctx = fs.build(
        user_request="Do something unrelated",
        recent_operations=[
            {"path": "README.md", "action": "read"},
            {"path": "requirements.txt", "action": "read"},
            {"path": ".env.example", "action": "read"},
            {"path": "pyproject.toml", "action": "read"},
        ],
        budget_tokens=10_000,
    )

    assert "### File: README.md" not in ctx
    assert "### File: requirements.txt" not in ctx
    assert "### File: .env.example" not in ctx
    assert "### File: pyproject.toml" not in ctx


def test_filesystem_context_includes_files_when_explicitly_requested(tmp_path):
    (tmp_path / "README.md").write_text("# Hello\n")
    (tmp_path / "requirements.txt").write_text("requests==2.0.0\n")
    (tmp_path / ".env.example").write_text("EXAMPLE=1\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n")

    fs = FilesystemContext(str(tmp_path))

    ctx = fs.build(user_request="Please review README.md", recent_operations=[], budget_tokens=10_000)
    assert "### File: README.md" in ctx

    ctx = fs.build(user_request="Check requirements.txt for pins", recent_operations=[], budget_tokens=10_000)
    assert "### File: requirements.txt" in ctx

    ctx = fs.build(user_request="Open .env.example and explain vars", recent_operations=[], budget_tokens=10_000)
    assert "### File: .env.example" in ctx

    ctx = fs.build(user_request="Check pyproject.toml configuration", recent_operations=[], budget_tokens=10_000)
    assert "### File: pyproject.toml" in ctx


def test_filesystem_context_tree_is_compact_and_truncated(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n")

    # Lots of non-key root files should not be listed in the tree.
    for i in range(50):
        (tmp_path / f"file_{i}.txt").write_text("x\n")

    # Create a src/ dir with many subdirs to trigger per-dir truncation.
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    for i in range(40):
        (src_dir / f"subdir_{i:02d}").mkdir()
        (src_dir / f"subdir_{i:02d}" / "ignored_file.py").write_text("print('x')\n")

    fs = FilesystemContext(str(tmp_path))
    ctx = fs.build(user_request="Do something unrelated", recent_operations=[], budget_tokens=10_000)

    assert "file_0.txt" not in ctx
    assert "pyproject.toml" not in ctx
    assert "more entries" in ctx
