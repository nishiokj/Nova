from __future__ import annotations

import re
from typing import List

from .models import HookDefinition, HookFilter, InvocationContext


class HookEngine:
    def evaluate(
        self,
        hooks: List[HookDefinition],
        trigger: str,
        context: InvocationContext,
    ) -> List[HookDefinition]:
        matches: List[HookDefinition] = []
        for hook in hooks:
            if not hook.enabled:
                continue
            if hook.trigger != trigger:
                continue
            if self._filter_matches(hook.filter, context):
                matches.append(hook)
        matches.sort(key=lambda h: h.priority, reverse=True)
        return matches

    def _filter_matches(self, filt: HookFilter, context: InvocationContext) -> bool:
        if filt.tool_name and filt.tool_name != context.tool_name:
            return False
        if filt.tier and filt.tier != context.tier:
            return False
        if filt.session_key and filt.session_key != context.session_key:
            return False
        if filt.request_id and filt.request_id != context.request_id:
            return False
        if filt.user_input_regex:
            if not context.user_input:
                return False
            if not re.search(filt.user_input_regex, context.user_input):
                return False
        return True
