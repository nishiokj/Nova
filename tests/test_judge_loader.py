import pytest

from evals.judge_loader import load_judge_config, list_available_judges


def test_list_available_judges_includes_default():
    judges = list_available_judges()
    assert isinstance(judges, dict)
    assert "default_judge" in judges


def test_load_judge_config_returns_required_fields():
    cfg = load_judge_config("default_judge")
    assert cfg["provider"]
    assert cfg["model"]


def test_load_judge_config_unknown_name_raises():
    with pytest.raises(ValueError):
        load_judge_config("nonexistent_judge")
