"""
HTML export system for human-reviewable evaluation results.

Generates interactive HTML pages with:
- Full prompts (system + user)
- Complete plans (steps, success criteria)
- Tool traces (every call with args/outputs)
- Reasoning at each step
- File state (git diffs, before/after)
- Latency metrics (per-phase breakdown)
- Manual review interface (checkboxes, notes, tags)
"""

from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime


class HTMLExporter:
    """Exports evaluation results to human-readable HTML."""

    def export(
        self,
        result_dict: Dict[str, Any],
        output_path: Path,
        redactions: Optional[List[Tuple[str, str]]] = None,
        records_dir: Optional[Path] = None
    ):
        """
        Export evaluation result as HTML.

        Args:
            result_dict: EvaluationResult as dict
            output_path: Where to write HTML
            redactions: List of (pattern_name, sample) redactions applied
            records_dir: Path to records directory (to fix artifact links)
        """
        scenario = result_dict['scenario']
        turns = scenario['turns']

        # Fix artifact paths if records_dir provided
        if records_dir:
            scenario_id = scenario['scenario_id']
            self._fix_artifact_paths(turns, scenario_id, output_path.parent, records_dir)

        html = self._generate_html(scenario, turns, redactions or [])

        output_path.write_text(html, encoding='utf-8')

    def _generate_html(
        self,
        scenario: Dict[str, Any],
        turns: List[Dict[str, Any]],
        redactions: List[Tuple[str, str]]
    ) -> str:
        """Generate complete HTML document."""
        scenario_id = scenario['scenario_id']
        task_id = scenario['task_id']

        turns_html = '\n'.join([
            self._generate_turn_html(turn, turn_idx + 1, len(turns))
            for turn_idx, turn in enumerate(turns)
        ])

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Eval: {scenario_id}</title>
    <style>
        {self._get_css()}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🔍 Evaluation Report</h1>
            <div class="scenario-info">
                <div><strong>Scenario ID:</strong> {scenario_id}</div>
                <div><strong>Task ID:</strong> {task_id}</div>
                <div><strong>Turns:</strong> {len(turns)}</div>
                <div><strong>Status:</strong> {self._status_badge(scenario['scenario_passed'])}</div>
                <div><strong>Total Latency:</strong> {scenario['total_latency_ms']:.0f}ms</div>
            </div>
        </header>

        <nav class="turn-nav">
            <h3>Navigate to Turn:</h3>
            {''.join([f'<a href="#turn{i+1}">Turn {i+1}</a>' for i in range(len(turns))])}
        </nav>

        {turns_html}

        <section class="final-state">
            <h2>📁 Final Workspace State</h2>
            {self._generate_file_state_html(scenario.get('all_file_operations', []))}
        </section>

        {self._generate_redactions_section(redactions)}

        <section class="manual-review">
            <h2>✍️ Manual Review</h2>
            <div class="review-form">
                <div class="form-group">
                    <label>
                        <input type="checkbox" id="overall-pass">
                        Scenario passed all requirements
                    </label>
                </div>
                <div class="form-group">
                    <label>Confidence (0-100):</label>
                    <input type="range" id="confidence" min="0" max="100" value="50">
                    <span id="confidence-value">50</span>
                </div>
                <div class="form-group">
                    <label>Tags:</label>
                    <div class="tags">
                        {self._generate_tag_checkboxes()}
                    </div>
                </div>
                <div class="form-group">
                    <label>Overall Notes:</label>
                    <textarea id="overall-notes" rows="5" placeholder="Enter your review notes here..."></textarea>
                </div>
                <button onclick="exportReview()">Export Review JSON</button>
            </div>
        </section>

        <section class="repro-context">
            <h2>🔬 Reproducibility Context</h2>
            {self._generate_repro_context_html(turns[0]['repro_context'] if turns else {})}
        </section>
    </div>

    <script>
        {self._get_javascript()}
    </script>
</body>
</html>"""

    def _generate_turn_html(self, turn: Dict[str, Any], turn_num: int, total_turns: int) -> str:
        """Generate HTML for a single turn."""
        repro = turn['repro_context']
        perf = turn['performance']

        # Prompts
        planning_prompt = self._generate_prompt_html(
            turn.get('full_prompt_planning'),
            "Planning"
        )
        execution_prompt = self._generate_prompt_html(
            turn.get('full_prompt_execution'),
            "Execution"
        )
        reflection_prompt = self._generate_prompt_html(
            turn.get('full_prompt_reflection'),
            "Reflection"
        )

        # Plan
        plan_html = self._generate_plan_html(turn.get('plan', {}), turn.get('plan_reasoning', ''))

        # Execution steps
        steps_html = self._generate_steps_html(turn.get('execution_steps', []))

        # Reflection
        reflection_html = self._generate_reflection_html(turn.get('reflection', {}))

        # File state
        file_state_html = self._generate_turn_file_state_html(turn.get('file_state', {}))

        # Performance
        perf_html = self._generate_performance_html(perf)

        return f"""
        <section class="turn" id="turn{turn_num}">
            <div class="turn-header">
                <h2>Turn {turn_num} of {total_turns}</h2>
                <div class="turn-status">
                    {self._status_badge(turn['success'])}
                </div>
            </div>

            <div class="user-prompt">
                <h3>👤 User Input</h3>
                <pre>{self._escape_html(turn['user_prompt'])}</pre>
            </div>

            <details class="collapsible" open>
                <summary>🎯 Planning Phase ({perf['planning_ms']:.0f}ms)</summary>
                <div class="phase-content">
                    {planning_prompt}
                    {plan_html}
                </div>
            </details>

            <details class="collapsible" open>
                <summary>⚙️ Execution Phase ({perf['execution_ms']:.0f}ms)</summary>
                <div class="phase-content">
                    {execution_prompt}
                    {steps_html}
                </div>
            </details>

            <details class="collapsible">
                <summary>🔍 Reflection Phase ({perf['reflection_ms']:.0f}ms)</summary>
                <div class="phase-content">
                    {reflection_prompt}
                    {reflection_html}
                </div>
            </details>

            <details class="collapsible">
                <summary>📁 File State Changes</summary>
                <div class="phase-content">
                    {file_state_html}
                </div>
            </details>

            <details class="collapsible">
                <summary>📊 Performance Metrics</summary>
                <div class="phase-content">
                    {perf_html}
                </div>
            </details>

            <div class="turn-review">
                <h3>Turn-Level Review</h3>
                <label>
                    <input type="checkbox" class="turn-pass" data-turn="{turn_num}">
                    Turn completed correctly
                </label>
                <textarea class="turn-notes" data-turn="{turn_num}" placeholder="Notes for turn {turn_num}..."></textarea>
            </div>
        </section>"""

    def _generate_prompt_html(self, prompt: Optional[Dict], _phase_name: str) -> str:
        """Generate HTML for a full prompt."""
        if not prompt:
            return '<p><em>No prompt recorded</em></p>'

        messages_html = []
        for msg in prompt.get('messages', []):
            role_icon = {'system': '🔧', 'user': '👤', 'assistant': '🤖'}.get(msg['role'], '💬')
            cached_badge = '<span class="cached-badge">cached</span>' if msg.get('cached') else ''

            content = msg.get('content', '')
            if len(content) > 5000:
                # Truncate very long content with expand button
                truncated = content[:5000]
                full = content
                content_html = f'''
                    <div class="truncated-content">
                        <pre class="preview">{self._escape_html(truncated)}</pre>
                        <button onclick="expandContent(this)">Show full content ({len(content)} chars)</button>
                        <pre class="full" style="display: none;">{self._escape_html(full)}</pre>
                    </div>
                '''
            else:
                content_html = f'<pre>{self._escape_html(content)}</pre>'

            messages_html.append(f'''
                <div class="message {msg['role']}">
                    <div class="message-header">
                        <span class="role-icon">{role_icon} {msg['role']}</span>
                        {cached_badge}
                        <span class="token-count">{msg.get('token_count', 0)} tokens</span>
                    </div>
                    {content_html}
                </div>
            ''')

        return f'''
            <div class="prompt-section">
                <h4>Full Prompt</h4>
                <div class="prompt-metadata">
                    <span>Model: {prompt.get('model', 'unknown')}</span>
                    <span>Temperature: {prompt.get('temperature', 0.0)}</span>
                    <span>Total tokens: {prompt.get('total_tokens', 0)}</span>
                    <span>Cached: {prompt.get('cached_tokens', 0)}</span>
                </div>
                <div class="messages">
                    {''.join(messages_html)}
                </div>
            </div>
        '''

    def _generate_plan_html(self, plan: Dict, reasoning: str) -> str:
        """Generate HTML for plan."""
        if not plan:
            return '<p><em>No plan recorded</em></p>'

        steps_html = []
        for step in plan.get('steps', []):
            steps_html.append(f'''
                <li>
                    <strong>Step {step.get('step_number', 0)}:</strong> {step.get('action', '')}
                    <br><small>Tool: {step.get('tool_hint', 'unknown')}</small>
                </li>
            ''')

        return f'''
            <div class="plan-section">
                <h4>Plan</h4>
                <div class="plan-reasoning">
                    <strong>Reasoning:</strong>
                    <pre>{self._escape_html(reasoning)}</pre>
                </div>
                <div class="plan-steps">
                    <strong>Steps:</strong>
                    <ol>{''.join(steps_html)}</ol>
                </div>
                <div class="success-criteria">
                    <strong>Success Criteria:</strong>
                    <ul>
                        {self._list_html(plan.get('success_criteria', []))}
                    </ul>
                </div>
            </div>
        '''

    def _generate_steps_html(self, steps: List[Dict]) -> str:
        """Generate HTML for execution steps."""
        if not steps:
            return '<p><em>No steps recorded</em></p>'

        steps_html = []
        for step in steps:
            tool_calls_html = []
            for tc in step.get('tool_calls', []):
                tool_calls_html.append(self._generate_tool_call_html(tc))

            status_icon = '✅' if step.get('success') else '❌'

            steps_html.append(f'''
                <div class="execution-step">
                    <div class="step-header">
                        <h4>Step {step['step_number']}: {step.get('step_description', '')} {status_icon}</h4>
                        <span class="duration">{step.get('duration_ms', 0):.0f}ms</span>
                    </div>
                    <div class="step-reasoning">
                        <strong>Reasoning:</strong>
                        <pre>{self._escape_html(step.get('reasoning', ''))}</pre>
                    </div>
                    <div class="tool-calls">
                        {''.join(tool_calls_html)}
                    </div>
                </div>
            ''')

        steps_content = ''.join(steps_html)
        return f'<div class="execution-steps">{steps_content}</div>'

    def _generate_tool_call_html(self, tc: Dict) -> str:
        """Generate HTML for a single tool call."""
        status_class = 'success' if tc.get('success') else 'error'
        status_icon = '✅' if tc.get('success') else '❌'

        # Arguments
        args_json = self._format_json(tc.get('arguments', {}))

        # Output
        output = tc.get('output', '')
        if tc.get('output_truncated'):
            output_html = f'''
                <pre class="truncated">{self._escape_html(output[:1000])}</pre>
                <p><em>Output truncated. Full output size: {tc.get('output_size_bytes', 0)} bytes</em></p>
                <p><a href="{tc.get('output_artifact_path', '')}">View full output</a></p>
            '''
        else:
            output_html = f'<pre>{self._escape_html(output)}</pre>'

        return f'''
            <div class="tool-call {status_class}">
                <div class="tool-call-header">
                    <strong>{tc['tool_name']}</strong>
                    {status_icon}
                    <span class="duration">{tc.get('duration_ms', 0):.0f}ms</span>
                </div>
                <details>
                    <summary>Arguments</summary>
                    <pre class="json">{args_json}</pre>
                </details>
                <details>
                    <summary>Output</summary>
                    {output_html}
                </details>
                {self._error_html(tc.get('error'))}
            </div>
        '''

    def _generate_reflection_html(self, reflection: Dict) -> str:
        """Generate HTML for reflection."""
        if not reflection:
            return '<p><em>No reflection recorded</em></p>'

        goal_achieved = reflection.get('goal_achieved', False)
        confidence = reflection.get('confidence', 0.0)

        return f'''
            <div class="reflection-section">
                <div class="reflection-result">
                    <strong>Goal Achieved:</strong>
                    {'✅ Yes' if goal_achieved else '❌ No'}
                    (confidence: {confidence:.2f})
                </div>
                <div class="reflection-evidence">
                    <strong>Evidence:</strong>
                    <ul>{self._list_html(reflection.get('evidence', []))}</ul>
                </div>
                <div class="reflection-gaps">
                    <strong>Gaps:</strong>
                    <ul>{self._list_html(reflection.get('gaps', []))}</ul>
                </div>
            </div>
        '''

    def _generate_turn_file_state_html(self, file_state: Dict) -> str:
        """Generate HTML for file state."""
        if not file_state:
            return '<p><em>No file state recorded</em></p>'

        git_diff = file_state.get('git_diff', '')
        operations = file_state.get('operations', [])

        ops_html = []
        for op in operations:
            icon = {'create': '➕', 'modify': '✏️', 'delete': '🗑️', 'read': '📖'}.get(op['operation'], '📄')
            ops_html.append(f'<li>{icon} <strong>{op["operation"]}</strong>: {op["path"]} ({op["tool_name"]})</li>')

        return f'''
            <div class="file-state">
                <div class="operations">
                    <h4>File Operations</h4>
                    <ul>{''.join(ops_html) if ops_html else '<li><em>No operations</em></li>'}</ul>
                </div>
                <div class="git-diff">
                    <h4>Git Diff</h4>
                    <pre class="diff">{self._escape_html(git_diff) if git_diff else '<em>No changes</em>'}</pre>
                </div>
            </div>
        '''

    def _generate_file_state_html(self, operations: List[Dict]) -> str:
        """Generate HTML for overall file state."""
        if not operations:
            return '<p><em>No file operations</em></p>'

        ops_by_file = {}
        for op in operations:
            path = op['path']
            if path not in ops_by_file:
                ops_by_file[path] = []
            ops_by_file[path].append(op)

        files_html = []
        for path, ops in ops_by_file.items():
            ops_list = ', '.join([op['operation'] for op in ops])
            files_html.append(f'<li><strong>{path}</strong>: {ops_list}</li>')

        files_content = ''.join(files_html)
        return f'<ul>{files_content}</ul>'

    def _generate_performance_html(self, perf: Dict) -> str:
        """Generate HTML for performance metrics."""
        total = perf['total_turn_ms']

        return f'''
            <div class="performance-metrics">
                <table>
                    <tr>
                        <th>Phase</th>
                        <th>Duration (ms)</th>
                        <th>Percentage</th>
                    </tr>
                    <tr>
                        <td>Planning</td>
                        <td>{perf['planning_ms']:.0f}</td>
                        <td>{(perf['planning_ms']/total*100):.1f}%</td>
                    </tr>
                    <tr>
                        <td>Execution</td>
                        <td>{perf['execution_ms']:.0f}</td>
                        <td>{(perf['execution_ms']/total*100):.1f}%</td>
                    </tr>
                    <tr>
                        <td>Reflection</td>
                        <td>{perf['reflection_ms']:.0f}</td>
                        <td>{(perf['reflection_ms']/total*100):.1f}%</td>
                    </tr>
                    <tr class="total">
                        <td><strong>Total</strong></td>
                        <td><strong>{total:.0f}</strong></td>
                        <td><strong>100%</strong></td>
                    </tr>
                </table>
            </div>
        '''

    def _generate_repro_context_html(self, repro: Dict) -> str:
        """Generate HTML for reproducibility context."""
        return f'''
            <div class="repro-context-data">
                <dl>
                    <dt>Scenario ID</dt><dd>{repro.get('scenario_id', '')}</dd>
                    <dt>Request ID</dt><dd>{repro.get('request_id', '')}</dd>
                    <dt>Tier</dt><dd>{repro.get('tier', '')}</dd>
                    <dt>Model</dt><dd>{repro.get('model', '')}</dd>
                    <dt>Temperature</dt><dd>{repro.get('temperature', 0)}</dd>
                    <dt>Git Commit</dt><dd><code>{repro.get('git_commit', '')[:8]}</code></dd>
                    <dt>Workspace</dt><dd><code>{repro.get('workspace_path', '')}</code></dd>
                    <dt>Python</dt><dd>{repro.get('python_version', '')}</dd>
                </dl>
            </div>
        '''

    def _generate_redactions_section(self, redactions: List[Tuple[str, str]]) -> str:
        """Generate section showing what was redacted."""
        if not redactions:
            return ''

        items_html = '\n'.join([
            f'<li><strong>{name}:</strong> <code>{sample}</code></li>'
            for name, sample in redactions
        ])

        return f'''
            <section class="redactions-info">
                <h2>🔒 Redacted Information</h2>
                <p>The following types of sensitive information were redacted from this report:</p>
                <ul>{items_html}</ul>
            </section>
        '''

    def _generate_tag_checkboxes(self) -> str:
        """Generate checkboxes for review tags."""
        tags = [
            'correct', 'incorrect', 'partial',
            'planning_error', 'execution_error', 'tool_misuse',
            'slow_planning', 'slow_execution',
            'edge_case_handled', 'good_solution'
        ]

        return ' '.join([
            f'<label><input type="checkbox" class="review-tag" value="{tag}"> {tag}</label>'
            for tag in tags
        ])

    # ========================================================================
    # Helpers
    # ========================================================================

    def _status_badge(self, passed: bool) -> str:
        """Generate status badge."""
        if passed:
            return '<span class="badge success">✓ PASSED</span>'
        else:
            return '<span class="badge error">✗ FAILED</span>'

    def _escape_html(self, text: str) -> str:
        """Escape HTML special characters."""
        if not text:
            return ''
        return (text
                .replace('&', '&amp;')
                .replace('<', '&lt;')
                .replace('>', '&gt;')
                .replace('"', '&quot;')
                .replace("'", '&#39;'))

    def _format_json(self, data: Any) -> str:
        """Format data as pretty JSON."""
        import json
        try:
            return json.dumps(data, indent=2)
        except:
            return str(data)

    def _list_html(self, items: List[str]) -> str:
        """Convert list to HTML list items."""
        if not items:
            return '<li><em>None</em></li>'
        return ''.join([f'<li>{self._escape_html(str(item))}</li>' for item in items])

    def _error_html(self, error: Optional[str]) -> str:
        """Generate error HTML if error exists."""
        if not error:
            return ''
        return f'<div class="error-message">❌ <strong>Error:</strong> {self._escape_html(error)}</div>'

    def _fix_artifact_paths(
        self,
        turns: List[Dict],
        scenario_id: str,
        html_dir: Path,
        records_dir: Path
    ):
        """
        Fix artifact paths to be relative from HTML directory to records directory.

        Artifact paths are stored as: artifacts/step2_Write_output.txt
        They're relative to: records/<scenario_id>/
        HTML is in: html/
        Need to change to: ../records/<scenario_id>/artifacts/...
        """
        for turn in turns:
            for step in turn.get('execution_steps', []):
                for tc in step.get('tool_calls', []):
                    if tc.get('output_artifact_path'):
                        # Original: artifacts/step2_Write_output.txt
                        # Need: ../records/<scenario_id>/artifacts/step2_Write_output.txt
                        relative_path = tc['output_artifact_path']
                        fixed_path = f"../records/{scenario_id}/{relative_path}"
                        tc['output_artifact_path'] = fixed_path

    def _get_css(self) -> str:
        """Get CSS styles."""
        return """
/* Rest of CSS continues in next message due to length... */
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    line-height: 1.6;
    color: #333;
    background: #f5f5f5;
    margin: 0;
    padding: 20px;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    background: white;
    padding: 30px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
}

header {
    border-bottom: 3px solid #007bff;
    padding-bottom: 20px;
    margin-bottom: 30px;
}

header h1 {
    margin: 0 0 15px 0;
    color: #007bff;
}

.scenario-info {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
    margin-top: 15px;
}

.badge {
    padding: 4px 12px;
    border-radius: 4px;
    font-weight: bold;
    font-size: 14px;
}

.badge.success {
    background: #28a745;
    color: white;
}

.badge.error {
    background: #dc3545;
    color: white;
}

.turn-nav {
    background: #f8f9fa;
    padding: 15px;
    border-radius: 6px;
    margin-bottom: 20px;
}

.turn-nav a {
    display: inline-block;
    padding: 6px 12px;
    margin: 0 5px;
    background: #007bff;
    color: white;
    text-decoration: none;
    border-radius: 4px;
}

.turn-nav a:hover {
    background: #0056b3;
}

.turn {
    border: 2px solid #dee2e6;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 30px;
}

.turn-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.user-prompt {
    background: #e3f2fd;
    border-left: 4px solid #2196f3;
    padding: 15px;
    margin-bottom: 20px;
}

.user-prompt pre {
    margin: 5px 0 0 0;
    white-space: pre-wrap;
}

.collapsible {
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 15px;
    margin-bottom: 15px;
}

.collapsible summary {
    cursor: pointer;
    font-weight: bold;
    font-size: 16px;
    padding: 5px;
}

.collapsible summary:hover {
    background: #e9ecef;
}

.phase-content {
    padding-top: 15px;
}

.message {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 12px;
    margin: 10px 0;
}

.message.system {
    background: #fff3cd;
    border-color: #ffc107;
}

.message.user {
    background: #e3f2fd;
    border-color: #2196f3;
}

.message.assistant {
    background: #f3e5f5;
    border-color: #9c27b0;
}

.message-header {
    font-weight: bold;
    margin-bottom: 8px;
    display: flex;
    gap: 10px;
    align-items: center;
}

.cached-badge {
    background: #28a745;
    color: white;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
}

.token-count {
    font-size: 12px;
    color: #666;
}

pre {
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    padding: 10px;
    overflow-x: auto;
    max-height: 500px;
}

.tool-call {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 10px;
    margin: 10px 0;
}

.tool-call.success {
    border-color: #28a745;
}

.tool-call.error {
    border-color: #dc3545;
    background: #f8d7da;
}

.tool-call-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}

.duration {
    font-size: 12px;
    color: #666;
    font-weight: normal;
}

table {
    width: 100%;
    border-collapse: collapse;
    margin: 15px 0;
}

table th, table td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid #dee2e6;
}

table th {
    background: #f8f9fa;
    font-weight: bold;
}

table tr.total {
    border-top: 2px solid #333;
}

.turn-review {
    background: #fff9e6;
    border: 2px dashed #ffc107;
    border-radius: 6px;
    padding: 15px;
    margin-top: 20px;
}

.turn-notes {
    width: 100%;
    margin-top: 10px;
    padding: 8px;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    font-family: inherit;
}

.manual-review {
    background: #f0f8ff;
    border: 3px solid #007bff;
    border-radius: 8px;
    padding: 20px;
    margin: 30px 0;
}

.form-group {
    margin-bottom: 15px;
}

.form-group label {
    display: block;
    font-weight: bold;
    margin-bottom: 5px;
}

.tags label {
    display: inline-block;
    margin-right: 15px;
    font-weight: normal;
}

button {
    background: #007bff;
    color: white;
    padding: 10px 20px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 16px;
}

button:hover {
    background: #0056b3;
}

textarea {
    width: 100%;
    padding: 8px;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    font-family: inherit;
}

.redactions-info {
    background: #fff3cd;
    border: 2px solid #ffc107;
    border-radius: 6px;
    padding: 15px;
    margin: 20px 0;
}

.error-message {
    background: #f8d7da;
    border: 1px solid #dc3545;
    color: #721c24;
    padding: 10px;
    border-radius: 4px;
    margin: 10px 0;
}
        """

    def _get_javascript(self) -> str:
        """Get JavaScript code."""
        return """
function expandContent(btn) {
    const container = btn.parentElement;
    const preview = container.querySelector('.preview');
    const full = container.querySelector('.full');
    if (full.style.display === 'none') {
        preview.style.display = 'none';
        full.style.display = 'block';
        btn.textContent = 'Show less';
    } else {
        preview.style.display = 'block';
        full.style.display = 'none';
        btn.textContent = 'Show full content';
    }
}

// Confidence slider
document.getElementById('confidence').addEventListener('input', function(e) {
    document.getElementById('confidence-value').textContent = e.target.value;
});

function exportReview() {
    const review = {
        overall_passed: document.getElementById('overall-pass').checked,
        confidence: parseInt(document.getElementById('confidence').value) / 100,
        tags: Array.from(document.querySelectorAll('.review-tag:checked')).map(cb => cb.value),
        overall_notes: document.getElementById('overall-notes').value,
        turn_reviews: [],
        reviewed_at: new Date().toISOString()
    };

    // Collect turn reviews
    document.querySelectorAll('.turn-pass').forEach(cb => {
        const turnNum = parseInt(cb.dataset.turn);
        const notes = document.querySelector(`.turn-notes[data-turn="${turnNum}"]`).value;
        review.turn_reviews.push({
            turn_number: turnNum,
            passed: cb.checked,
            notes: notes
        });
    });

    // Download as JSON
    const blob = new Blob([JSON.stringify(review, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'review_' + new Date().toISOString() + '.json';
    a.click();
    URL.revokeObjectURL(url);

    alert('Review exported! Check your downloads.');
}
        """
