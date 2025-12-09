"""
Comprehensive tests for the Router component.

Tests:
- Pattern classification accuracy
- Tier assignment correctness
- Edge cases and fallbacks
- Performance considerations
"""

import sys
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.router import (
    Router, PatternClassifier, TaskClassification, TaskTier,
    RouterConfig, AdaptiveRouter
)
from harness.config import LLMConfig

from tests.test_helpers import TEST_DATA


class TestPatternClassifier:
    """Test the pattern-based classifier"""

    @pytest.fixture
    def classifier(self):
        return PatternClassifier()

    # =========================================================================
    # SIMPLE TIER CLASSIFICATION
    # =========================================================================

    @pytest.mark.parametrize("query", [
        # Greetings
        "Hello!",
        "Hi there",
        "Hey",
        "Thanks for your help",
        "Thank you",
        "Bye",
        "Goodbye",
        "Good morning",
        "Good afternoon",
        "Good evening",
        # Simple confirmations
        "Yes",
        "No",
        "Ok",
        "Okay",
        "Sure",
        "Fine",
        "Great",
        "Yep",
        "Nope",
        "Yeah",
        "Nah",
    ])
    def test_simple_tier_greetings(self, classifier, query):
        """Test that greetings and simple responses are classified as simple"""
        result = classifier.classify(query)
        assert result is not None
        assert result.tier == TaskTier.SIMPLE, f"'{query}' should be SIMPLE, got {result.tier}"

    @pytest.mark.parametrize("query", [
        # Questions
        "What is the capital of France?",
        "Who invented the telephone?",
        "When was the Declaration of Independence signed?",
        "Where is the Eiffel Tower?",
        "How is glass made?",
        "Tell me about dinosaurs",
        "What's the meaning of life?",
        "What does 'ephemeral' mean?",
        "Explain photosynthesis",
        # Time/Date/Weather
        "What time is it?",
        "What's the date today?",
        "What's the weather like?",
        "What's the temperature?",
        "What's the forecast?",
        # Definitions
        "Define 'serendipity'",
        "What does 'ubiquitous' mean?",
        "Meaning of 'paradigm'",
        # Math
        "Calculate 25 + 37",
        "What is 100 divided by 4?",
        "Compute 15 * 3",
        "How much is 2+2?",
        # Conversions
        "Convert 100 miles to kilometers",
        "How many inches in a foot?",
        "Convert 32 Fahrenheit to Celsius",
        # Simple requests
        "Show me the schedule",
        "List all options",
        "Give me a summary",
        "Summarize this",
        "Give me a tldr",  # tldr pattern (lowercase word boundary)
        # Facts
        "Who founded Apple?",
        "What is the capital of Japan?",
        "Who is the president of the United States?",
        "What is the population of China?",
    ])
    def test_simple_tier_questions(self, classifier, query):
        """Test that simple questions are classified as simple"""
        result = classifier.classify(query)
        assert result is not None
        assert result.tier == TaskTier.SIMPLE, f"'{query}' should be SIMPLE, got {result.tier}"

    # =========================================================================
    # STANDARD TIER CLASSIFICATION
    # =========================================================================

    @pytest.mark.parametrize("query", [
        # Web/Search
        "Search for the latest news about AI",
        "Look up information about climate change",
        "Find articles about renewable energy",
        "Google the stock price of Apple",
        "Browse the web for vacation ideas",
        # File operations
        "Read the file config.json",
        "Open my document",
        "Load the contents from readme.md",  # 'load' triggers tool pattern
        "Load the settings file",
        "Write to the output file",
        "Save this to a file",
        # System commands
        "Run the command ls -la",
        "Execute the script",
        "Open the terminal",
        "Install the package",
        "Update the dependencies",
        # API/Network
        "Fetch data from the API",
        "Make a request to the endpoint",
        "Get the response from the server",
        "Call the HTTP endpoint",
    ])
    def test_standard_tier_tool_usage(self, classifier, query):
        """Test that tool-requiring queries are classified as standard"""
        result = classifier.classify(query)
        assert result is not None
        assert result.tier == TaskTier.STANDARD, f"'{query}' should be STANDARD, got {result.tier}"

    # =========================================================================
    # ADVANCED TIER CLASSIFICATION
    # =========================================================================

    @pytest.mark.parametrize("query", [
        # Code generation (pattern: develop/build/implement + code/program/script/application/function/class)
        "Write a Python function to sort a list",
        "Create a JavaScript class for user management",
        "Generate a REST API for the project",
        "Build a web application",
        "Implement a binary search algorithm",
        "Develop a new code module",  # "code" is in the pattern
        "Code a recursive function",
        # Analysis/Research (pattern: analyze/research/investigate/examine/study)
        "Analyze this code and suggest improvements",
        "Research the history of computing",
        "Investigate the bug in the application",
        "Deep dive into database optimization",
        "Examine the system architecture",
        "Study the performance metrics",
        # Complex tasks (pattern: debug/fix/troubleshoot/solve + error/bug/issue/problem)
        "Debug the error in my application",
        "Fix the bug in the login system",
        "Troubleshoot the connection issue",
        "Solve this complex algorithm problem",
        # Comparison/Evaluation (pattern: compare/evaluate/assess/review + and/vs/versus/between)
        "Compare React and Vue for web development",
        "Evaluate the pros and cons of microservices",
        "Assess security risks versus performance gains",  # needs "versus"
        "Review this code and the previous version",  # needs "and"
        # Optimization (pattern: optimize/improve/enhance/refactor/redesign)
        "Optimize the database queries",
        "Improve the application performance",
        "Refactor the codebase",
        "Enhance the user experience",
        "Redesign the architecture",
        # Multi-step (pattern: step by step|walkthrough|guide me|help me build)
        "Help me build a complete authentication system",
        "Guide me through setting up CI/CD",
        "Please provide a walkthrough of the deployment",  # avoids "give me" simple pattern
        "Step by step, create a REST API",
    ])
    def test_advanced_tier_complex(self, classifier, query):
        """Test that complex queries are classified as advanced"""
        result = classifier.classify(query)
        assert result is not None
        assert result.tier == TaskTier.ADVANCED, f"'{query}' should be ADVANCED, got {result.tier}"

    # =========================================================================
    # EDGE CASES
    # =========================================================================

    def test_empty_input(self, classifier):
        """Test classification of empty input"""
        result = classifier.classify("")
        assert result is not None
        # Should default to standard
        assert result.tier == TaskTier.STANDARD

    def test_whitespace_only(self, classifier):
        """Test classification of whitespace-only input"""
        result = classifier.classify("   ")
        assert result is not None
        assert result.tier == TaskTier.STANDARD

    def test_special_characters(self, classifier):
        """Test classification with special characters"""
        result = classifier.classify("!@#$%^&*()")
        assert result is not None
        # Should still return a classification

    def test_very_long_input(self, classifier):
        """Test classification of very long input"""
        long_query = "What is " + "very " * 1000 + "important?"
        result = classifier.classify(long_query)
        assert result is not None

    def test_unicode_input(self, classifier):
        """Test classification with unicode characters"""
        result = classifier.classify("What is 你好 in English?")
        assert result is not None
        assert result.tier == TaskTier.SIMPLE  # It's still a "what is" question

    def test_emoji_input(self, classifier):
        """Test classification with emojis"""
        result = classifier.classify("What does 🔥 mean?")
        assert result is not None

    def test_mixed_case(self, classifier):
        """Test that classification is case-insensitive"""
        lower_result = classifier.classify("what is the weather?")
        upper_result = classifier.classify("WHAT IS THE WEATHER?")
        mixed_result = classifier.classify("WhAt Is ThE wEaThEr?")

        assert lower_result.tier == upper_result.tier == mixed_result.tier == TaskTier.SIMPLE

    def test_confidence_score(self, classifier):
        """Test that confidence scores are returned"""
        result = classifier.classify("What time is it?")
        assert result.confidence > 0
        assert result.confidence <= 1.0

    def test_metadata_includes_classifier(self, classifier):
        """Test that metadata includes classifier type"""
        result = classifier.classify("Hello")
        assert "classifier" in result.metadata
        assert result.metadata["classifier"] == "pattern"


class TestRouter:
    """Test the Router component"""

    def test_router_enabled(self, router):
        """Test that router can be enabled/disabled"""
        assert router.enabled

        router.disable()
        assert not router.enabled

        router.enable()
        assert router.enabled

    def test_route_returns_classification_and_config(self, router):
        """Test that route returns both classification and tier config"""
        classification, tier_config = router.route("What is 2+2?")

        assert isinstance(classification, TaskClassification)
        assert classification.tier == TaskTier.SIMPLE

    def test_router_disabled_uses_default(self, router):
        """Test that disabled router uses default tier"""
        router.disable()
        router.config.default_tier = "advanced"

        classification = router.classify("simple question")
        assert classification.tier == TaskTier.ADVANCED
        assert classification.metadata["classifier"] == "disabled"

    def test_set_default_tier(self, router):
        """Test setting default tier"""
        router.set_default_tier("advanced")
        assert router.config.default_tier == "advanced"

        router.set_default_tier("simple")
        assert router.config.default_tier == "simple"

    def test_set_invalid_tier(self, router):
        """Test setting an invalid tier (should be ignored)"""
        original = router.config.default_tier
        router.set_default_tier("invalid_tier")
        assert router.config.default_tier == original

    def test_tier_config_mapping(self, router):
        """Test that tier configs can be set and retrieved"""
        mock_config = {"model": "test-model"}
        router.set_tier_config(TaskTier.SIMPLE, mock_config)

        classification, tier_config = router.route("Hello")
        assert tier_config == mock_config

    def test_classify_with_context(self, router):
        """Test classification with additional context"""
        classification = router.classify(
            "continue",
            context="We were discussing Python programming"
        )
        # With context about programming, might be classified differently
        assert classification is not None


class TestRouterAccuracy:
    """Test router classification accuracy on diverse inputs"""

    @pytest.fixture
    def router(self):
        config = RouterConfig(enabled=True, default_tier="standard")
        return Router(config)

    def test_simple_queries_accuracy(self, router):
        """Test accuracy on simple queries"""
        simple_queries = TEST_DATA.SIMPLE_QUERIES
        correct = 0
        for query in simple_queries:
            result = router.classify(query)
            if result.tier == TaskTier.SIMPLE:
                correct += 1

        accuracy = correct / len(simple_queries)
        assert accuracy >= 0.7, f"Simple query accuracy too low: {accuracy:.1%}"

    def test_standard_queries_accuracy(self, router):
        """Test accuracy on standard queries"""
        standard_queries = TEST_DATA.STANDARD_QUERIES
        correct = 0
        for query in standard_queries:
            result = router.classify(query)
            if result.tier == TaskTier.STANDARD:
                correct += 1

        accuracy = correct / len(standard_queries)
        assert accuracy >= 0.5, f"Standard query accuracy too low: {accuracy:.1%}"

    def test_advanced_queries_accuracy(self, router):
        """Test accuracy on advanced queries"""
        advanced_queries = TEST_DATA.ADVANCED_QUERIES
        correct = 0
        for query in advanced_queries:
            result = router.classify(query)
            if result.tier == TaskTier.ADVANCED:
                correct += 1

        accuracy = correct / len(advanced_queries)
        assert accuracy >= 0.5, f"Advanced query accuracy too low: {accuracy:.1%}"

    def test_edge_cases_dont_crash(self, router):
        """Test that edge cases don't cause crashes"""
        for query in TEST_DATA.EDGE_CASE_QUERIES:
            try:
                result = router.classify(query)
                assert result is not None
            except Exception as e:
                pytest.fail(f"Query '{query[:50]}...' caused exception: {e}")


class TestAdaptiveRouter:
    """Test the adaptive router with feedback learning"""

    @pytest.fixture
    def adaptive_router(self):
        config = RouterConfig(enabled=True, default_tier="standard")
        return AdaptiveRouter(config)

    def test_record_feedback(self, adaptive_router):
        """Test recording classification feedback"""
        classification = TaskClassification(
            tier=TaskTier.SIMPLE,
            confidence=0.9,
            reasoning="Pattern match"
        )

        adaptive_router.record_feedback(
            text="What is 2+2?",
            classification=classification,
            actual_tier=TaskTier.SIMPLE,
            success=True
        )

        assert len(adaptive_router.feedback_history) == 1

    def test_accuracy_tracking(self, adaptive_router):
        """Test that accuracy is tracked correctly"""
        # Record some feedback
        for i in range(10):
            tier = TaskTier.SIMPLE if i < 8 else TaskTier.STANDARD
            classification = TaskClassification(tier=tier, confidence=0.9)
            adaptive_router.record_feedback(
                text=f"query {i}",
                classification=classification,
                actual_tier=tier,  # All correct
                success=True
            )

        stats = adaptive_router.get_classification_accuracy()
        assert stats["overall_accuracy"] == 1.0  # All correct
        assert stats["total_classifications"] == 10

    def test_mismatch_detection(self, adaptive_router):
        """Test that mismatches are detected"""
        classification = TaskClassification(
            tier=TaskTier.SIMPLE,
            confidence=0.9
        )

        adaptive_router.record_feedback(
            text="Write a Python function",
            classification=classification,
            actual_tier=TaskTier.ADVANCED,  # Mismatch!
            success=False
        )

        stats = adaptive_router.get_classification_accuracy()
        assert stats["overall_accuracy"] < 1.0


class TestRouterPerformance:
    """Test router performance characteristics"""

    @pytest.fixture
    def router(self):
        config = RouterConfig(enabled=True, default_tier="standard")
        return Router(config)

    def test_classification_speed(self, router):
        """Test that pattern classification is fast"""
        import time

        queries = TEST_DATA.SIMPLE_QUERIES + TEST_DATA.STANDARD_QUERIES

        start = time.time()
        for query in queries:
            router.classify(query)
        elapsed = time.time() - start

        avg_time = elapsed / len(queries)
        assert avg_time < 0.01, f"Classification too slow: {avg_time*1000:.2f}ms per query"

    def test_batch_classification_speed(self, router):
        """Test classification speed for batch of 100 queries"""
        import time

        queries = (TEST_DATA.SIMPLE_QUERIES * 10)[:100]

        start = time.time()
        for query in queries:
            router.classify(query)
        elapsed = time.time() - start

        assert elapsed < 1.0, f"Batch classification too slow: {elapsed:.2f}s for 100 queries"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
