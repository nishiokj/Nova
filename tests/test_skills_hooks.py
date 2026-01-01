"""
Tests for skills and hooks.
"""

from datetime import datetime

import pytest

from skills.store import SkillStore, StoreError as SkillStoreError
from skills.registry import SkillRegistry
from skills.router import SkillRouter
from skills.runner import SkillRunner
from hooks.store import HookStore, StoreError as HookStoreError
from hooks.engine import HookEngine
from hooks.manager import HookManager
from hooks.models import HookDefinition, InvocationContext
from util.config import SkillsConfig, HooksConfig, ToolConfig
from harness.agent.tool_registry import ToolRegistry


def _now_rfc3339() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _skill_def(skill_id: str, trigger: dict) -> dict:
    ts = _now_rfc3339()
    return {
        "id": skill_id,
        "name": f"Skill {skill_id}",
        "description": "Test skill",
        "version": "v1",
        "type": "workflow",
        "triggers": [trigger],
        "input_schema": {"type": "object", "properties": {}, "required": []},
        "steps": [{"name": "calc", "tool": "calculator", "args": {"expression": "2+2"}}],
        "allowed_tools": ["calculator"],
        "timeout_ms": 1000,
        "enabled": True,
        "tags": [],
        "created_at": ts,
        "updated_at": ts,
    }


def _hook_def(hook_id: str) -> dict:
    ts = _now_rfc3339()
    return {
        "id": hook_id,
        "name": f"Hook {hook_id}",
        "description": "Test hook",
        "enabled": True,
        "trigger": "tool.before",
        "priority": 10,
        "timeout_ms": 100,
        "fail_open": True,
        "filter": {"tool_name": "calculator"},
        "action": {
            "type": "mutate",
            "ops": [
                {"op": "transform_tool_args", "path": "expression", "value": "3+3"},
            ],
        },
        "created_at": ts,
        "updated_at": ts,
    }


def test_skill_store_crud(temp_dir, mock_logger):
    store = SkillStore(temp_dir, logger=mock_logger)
    definition = _skill_def("test_skill", {"type": "regex", "pattern": "^test"})

    created = store.create(definition)
    assert created.id == "test_skill"

    fetched = store.get("test_skill")
    assert fetched.name == "Skill test_skill"

    updated = store.update("test_skill", {**definition, "name": "Updated"})
    assert updated.name == "Updated"

    assert store.delete("test_skill") is True

    with pytest.raises(SkillStoreError):
        store.get("test_skill")


def test_skill_store_validation_error(temp_dir, mock_logger):
    store = SkillStore(temp_dir, logger=mock_logger)
    invalid = _skill_def("bad id", {"type": "regex", "pattern": "^test"})
    with pytest.raises(SkillStoreError):
        store.create(invalid)


def test_skill_router_regex_and_keyword(temp_dir, mock_logger):
    store = SkillStore(temp_dir, logger=mock_logger)
    store.create(_skill_def("alpha", {"type": "regex", "pattern": "^alpha"}))
    store.create(_skill_def("beta", {"type": "keyword", "keywords": ["beta", "b"]}))

    registry = SkillRegistry(store, logger=mock_logger)
    router = SkillRouter(registry, SkillsConfig(semantic_enabled=False), logger=mock_logger)

    match = router.route("alpha test", "standard", None)
    assert match is not None
    assert match.skill.id == "alpha"

    match = router.route("use beta please", "standard", None)
    assert match is not None
    assert match.skill.id == "beta"


def test_skill_runner_template_and_allowlist(tool_registry):
    runner = SkillRunner(tool_registry)
    ts = _now_rfc3339()
    definition = {
        "id": "templated",
        "name": "Templated",
        "description": "Template test",
        "version": "v1",
        "type": "workflow",
        "triggers": [{"type": "regex", "pattern": "^temp"}],
        "input_schema": {
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"],
        },
        "steps": [{"name": "calc", "tool": "calculator", "args": {"expression": "{{input.expression}}"}}],
        "allowed_tools": ["calculator"],
        "timeout_ms": 1000,
        "enabled": True,
        "tags": [],
        "created_at": ts,
        "updated_at": ts,
    }

    from skills.models import SkillDefinition

    skill = SkillDefinition.model_validate(definition)
    result = runner.run(skill, {"expression": "2+5"})
    assert result.success
    assert result.output == 7

    definition["allowed_tools"] = ["file_read"]
    skill = SkillDefinition.model_validate(definition)
    result = runner.run(skill, {"expression": "2+5"})
    assert not result.success
    assert "not allowed" in (result.error or "")


def test_hook_engine_filter(mock_logger):
    hook = HookDefinition.model_validate(_hook_def("filter_hook"))
    engine = HookEngine()
    ctx = InvocationContext(
        request_id="req1",
        session_key=None,
        user_input="calculate",
        tier="standard",
        tool_name="calculator",
    )
    matches = engine.evaluate([hook], "tool.before", ctx)
    assert len(matches) == 1


def test_tool_hook_mutates_args(temp_dir, mock_logger):
    hook_store = HookStore(temp_dir, logger=mock_logger)
    hook_store.create(_hook_def("mutate_args"))
    hook_manager = HookManager(hook_store, HooksConfig(enabled=True), logger=mock_logger)

    config = ToolConfig(enabled_tools=["calculator"])
    registry = ToolRegistry(config, logger=mock_logger, hook_manager=hook_manager)
    context = InvocationContext(
        request_id="req2",
        session_key=None,
        user_input="calc",
        tier="standard",
    )
    with registry.with_invocation_context(context):
        result = registry.execute("calculator", expression="1+1")
    assert result.output == 6
