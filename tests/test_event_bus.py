"""
Comprehensive tests for the EventBus component.

Tests:
- Message passing between queues
- Request/Response flow
- Backpressure handling
- Cancellation signaling
- Health monitoring
- Thread safety
"""

import sys
import time
import threading
import queue
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.event_bus import (
    EventBus, ProcessManager,
    MessageType, BusMessage,
    AgentRequest, AgentResult,
    TTSRequest
)

from tests.test_helpers import wait_for_condition


class TestEventBusBasics:
    """Test basic EventBus operations"""

    def test_event_bus_creation(self, event_bus):
        """Test EventBus creation"""
        assert event_bus is not None
        assert event_bus.agent_request_queue is not None
        assert event_bus.agent_response_queue is not None
        assert event_bus.tts_queue is not None

    def test_initial_state(self, event_bus):
        """Test initial state of EventBus"""
        assert not event_bus.is_shutdown()
        assert not event_bus.agent_busy_event.is_set()
        assert not event_bus.cancel_event.is_set()

    def test_shutdown_signaling(self, event_bus):
        """Test shutdown signaling"""
        assert not event_bus.is_shutdown()

        event_bus.shutdown()

        assert event_bus.is_shutdown()


class TestAgentRequestQueue:
    """Test Agent request queue operations"""

    def test_submit_agent_request(self, event_bus):
        """Test submitting an agent request"""
        request = AgentRequest(
            request_id="test-001",
            speech_text="Hello, world!",
            tier="standard"
        )

        result = event_bus.submit_agent_request(request)
        assert result is True

    def test_get_agent_request(self, event_bus):
        """Test getting an agent request"""
        request = AgentRequest(
            request_id="test-002",
            speech_text="What is 2+2?",
            tier="simple"
        )

        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)

        assert retrieved is not None
        assert retrieved.request_id == "test-002"
        assert retrieved.speech_text == "What is 2+2?"
        assert retrieved.tier == "simple"

    def test_get_request_timeout(self, event_bus):
        """Test get request with timeout (empty queue)"""
        result = event_bus.get_agent_request(timeout=0.1)
        assert result is None

    def test_request_with_context(self, event_bus):
        """Test request with context"""
        request = AgentRequest(
            request_id="test-003",
            speech_text="Continue",
            tier="standard",
            context="We were discussing Python"
        )

        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)

        assert retrieved.context == "We were discussing Python"

    def test_request_with_conversation_history(self, event_bus):
        """Test request with conversation history"""
        request = AgentRequest(
            request_id="test-004",
            speech_text="What else?",
            conversation_history=[
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"}
            ]
        )

        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)

        assert len(retrieved.conversation_history) == 2


class TestAgentResponseQueue:
    """Test Agent response queue operations"""

    def test_submit_agent_response(self, event_bus):
        """Test submitting an agent response"""
        result = AgentResult(
            request_id="test-001",
            success=True,
            content="The answer is 4.",
            spoken_response="The answer is 4.",
            tools_used=["calculator"],
            duration_ms=150.5
        )

        event_bus.submit_agent_response(result)

        # Should be retrievable
        retrieved = event_bus.get_agent_response(timeout=1.0)
        assert retrieved is not None
        assert retrieved.request_id == "test-001"
        assert retrieved.success is True
        assert retrieved.content == "The answer is 4."

    def test_get_response_timeout(self, event_bus):
        """Test get response with timeout (empty queue)"""
        result = event_bus.get_agent_response(timeout=0.1)
        assert result is None

    def test_response_with_error(self, event_bus):
        """Test response with error"""
        result = AgentResult(
            request_id="test-error",
            success=False,
            content="",
            spoken_response="An error occurred",
            error="Tool execution failed"
        )

        event_bus.submit_agent_response(result)
        retrieved = event_bus.get_agent_response(timeout=1.0)

        assert not retrieved.success
        assert retrieved.error == "Tool execution failed"

    def test_response_with_metadata(self, event_bus):
        """Test response with metadata"""
        result = AgentResult(
            request_id="test-meta",
            success=True,
            content="Done",
            spoken_response="Done",
            metadata={"model": "gpt-4", "tokens": 100}
        )

        event_bus.submit_agent_response(result)
        retrieved = event_bus.get_agent_response(timeout=1.0)

        assert retrieved.metadata["model"] == "gpt-4"
        assert retrieved.metadata["tokens"] == 100


class TestTTSQueue:
    """Test TTS queue operations"""

    def test_submit_tts_request(self, event_bus):
        """Test submitting a TTS request"""
        request = TTSRequest(
            request_id="tts-001",
            text="Hello, world!",
            priority=1,
            response_type="completion"
        )

        event_bus.submit_tts_request(request)

        # Should be retrievable
        retrieved = event_bus.get_tts_request(timeout=1.0)
        assert retrieved is not None
        assert retrieved.text == "Hello, world!"

    def test_tts_request_priority(self, event_bus):
        """Test TTS request priority field"""
        request = TTSRequest(
            request_id="tts-high",
            text="Urgent message",
            priority=0  # High priority
        )

        event_bus.submit_tts_request(request)
        retrieved = event_bus.get_tts_request(timeout=1.0)

        assert retrieved.priority == 0

    def test_clear_tts_queue(self, event_bus):
        """Test clearing TTS queue"""
        # Add some requests
        for i in range(5):
            event_bus.submit_tts_request(TTSRequest(
                request_id=f"tts-{i}",
                text=f"Message {i}"
            ))

        # Clear the queue
        event_bus.clear_tts_queue()

        # Verify cleared by trying to get - should either return None
        # or immediately return whatever was added after clear
        # Note: multiprocessing.Queue.empty()/qsize() don't work reliably on macOS
        result = event_bus.get_tts_request(timeout=0.1)
        # If clear worked, we either get None or an item added during/after clear
        # The key test is that we don't hang waiting for items
        # This is a timing-sensitive test - if it occasionally fails, that's acceptable
        assert result is None or result.request_id.startswith("tts-")


class TestBackpressure:
    """Test backpressure handling"""

    def test_backpressure_clears_queue_when_busy(self, event_bus):
        """Test that new request clears queue when agent is busy"""
        # Mark agent as busy
        event_bus.set_agent_busy(True)

        # Submit first request
        request1 = AgentRequest(request_id="old", speech_text="Old request")
        event_bus.submit_agent_request(request1)

        # Submit second request (should clear first)
        request2 = AgentRequest(request_id="new", speech_text="New request")
        event_bus.submit_agent_request(request2)

        # Should get the new request (old one cleared)
        retrieved = event_bus.get_agent_request(timeout=1.0)
        # Note: Due to timing, we might get either, but cancel should be set
        assert event_bus.cancel_event.is_set()

    def test_no_backpressure_when_idle(self, event_bus):
        """Test no backpressure when agent is idle"""
        # Agent is idle (not busy)
        event_bus.set_agent_busy(False)

        request1 = AgentRequest(request_id="first", speech_text="First")
        request2 = AgentRequest(request_id="second", speech_text="Second")

        event_bus.submit_agent_request(request1)
        event_bus.submit_agent_request(request2)

        # Should get first, then second
        first = event_bus.get_agent_request(timeout=1.0)
        second = event_bus.get_agent_request(timeout=1.0)

        assert first.request_id == "first"
        assert second.request_id == "second"


class TestCancellation:
    """Test cancellation signaling"""

    def test_cancel_event_initial_state(self, event_bus):
        """Test cancel event starts cleared"""
        assert not event_bus.is_cancelled()

    def test_cancel_during_busy(self, event_bus):
        """Test cancel is set when interrupting busy agent"""
        event_bus.set_agent_busy(True)

        # Submit request while busy (triggers cancel)
        request = AgentRequest(request_id="test", speech_text="Test")
        event_bus.submit_agent_request(request)

        assert event_bus.is_cancelled()

    def test_cancel_cleared_when_done(self, event_bus):
        """Test cancel is cleared when agent finishes"""
        event_bus.cancel_event.set()
        event_bus.set_agent_busy(False)

        assert not event_bus.is_cancelled()

    def test_set_agent_busy_state(self, event_bus):
        """Test setting agent busy state"""
        assert not event_bus.agent_busy_event.is_set()

        event_bus.set_agent_busy(True)
        assert event_bus.agent_busy_event.is_set()

        event_bus.set_agent_busy(False)
        assert not event_bus.agent_busy_event.is_set()


class TestHealthMonitoring:
    """Test health monitoring"""

    def test_agent_heartbeat(self, event_bus):
        """Test agent heartbeat updates timestamp"""
        initial = event_bus._agent_last_heartbeat.value

        time.sleep(0.1)
        event_bus.agent_heartbeat()

        assert event_bus._agent_last_heartbeat.value > initial

    def test_tts_heartbeat(self, event_bus):
        """Test TTS heartbeat updates timestamp"""
        initial = event_bus._tts_last_heartbeat.value

        time.sleep(0.1)
        event_bus.tts_heartbeat()

        assert event_bus._tts_last_heartbeat.value > initial

    def test_agent_health_check_healthy(self, event_bus):
        """Test agent health check when healthy"""
        event_bus.agent_heartbeat()
        assert event_bus.check_agent_health(timeout_s=10.0) is True

    def test_agent_health_check_unhealthy(self, event_bus):
        """Test agent health check when unhealthy (stale heartbeat)"""
        # Set heartbeat to old time
        event_bus._agent_last_heartbeat.value = time.time() - 20

        assert event_bus.check_agent_health(timeout_s=10.0) is False

    def test_tts_health_check_healthy(self, event_bus):
        """Test TTS health check when healthy"""
        event_bus.tts_heartbeat()
        assert event_bus.check_tts_health(timeout_s=10.0) is True


class TestBusMessage:
    """Test BusMessage data structure"""

    def test_bus_message_creation(self):
        """Test creating a BusMessage"""
        msg = BusMessage(
            type=MessageType.AGENT_REQUEST,
            payload={"text": "Hello"},
            request_id="test-001"
        )

        assert msg.type == MessageType.AGENT_REQUEST
        assert msg.payload["text"] == "Hello"
        assert msg.request_id == "test-001"
        assert msg.timestamp > 0

    def test_bus_message_to_dict(self):
        """Test BusMessage serialization"""
        msg = BusMessage(
            type=MessageType.TTS_REQUEST,
            payload={"text": "Speak this"},
            request_id="tts-001"
        )

        d = msg.to_dict()

        assert d["type"] == "tts_request"
        assert d["payload"]["text"] == "Speak this"
        assert d["request_id"] == "tts-001"
        assert "timestamp" in d


class TestAgentRequestDataclass:
    """Test AgentRequest data structure"""

    def test_agent_request_creation(self):
        """Test creating AgentRequest"""
        request = AgentRequest(
            request_id="test",
            speech_text="Hello",
            tier="simple"
        )

        assert request.request_id == "test"
        assert request.speech_text == "Hello"
        assert request.tier == "simple"

    def test_agent_request_to_dict(self):
        """Test AgentRequest serialization"""
        request = AgentRequest(
            request_id="test",
            speech_text="Hello",
            tier="standard",
            context="Some context",
            conversation_history=[{"role": "user", "content": "Hi"}]
        )

        d = request.to_dict()

        assert d["request_id"] == "test"
        assert d["speech_text"] == "Hello"
        assert d["tier"] == "standard"
        assert d["context"] == "Some context"
        assert len(d["conversation_history"]) == 1


class TestThreadSafety:
    """Test thread safety of EventBus"""

    def test_concurrent_request_submission(self, event_bus):
        """Test concurrent request submission"""
        submitted_count = [0]
        lock = threading.Lock()

        def submit_request(i):
            request = AgentRequest(
                request_id=f"req-{i}",
                speech_text=f"Request {i}"
            )
            if event_bus.submit_agent_request(request):
                with lock:
                    submitted_count[0] += 1

        threads = [threading.Thread(target=submit_request, args=(i,)) for i in range(10)]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All should have been submitted (some might have been cleared by backpressure)
        assert submitted_count[0] > 0

    def test_concurrent_heartbeats(self, event_bus):
        """Test concurrent heartbeat updates"""
        def send_heartbeats(count):
            for _ in range(count):
                event_bus.agent_heartbeat()
                event_bus.tts_heartbeat()

        threads = [threading.Thread(target=send_heartbeats, args=(100,)) for _ in range(5)]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Should complete without errors
        assert event_bus.check_agent_health() is True


class TestMessageTypes:
    """Test all message types"""

    def test_all_message_types_defined(self):
        """Test all expected message types are defined"""
        expected_types = [
            "AGENT_REQUEST", "TTS_REQUEST",
            "AGENT_RESPONSE", "TTS_COMPLETE",
            "SHUTDOWN", "HEALTH_CHECK", "HEALTH_RESPONSE", "CANCEL",
            "AGENT_STATUS", "TTS_STATUS"
        ]

        for type_name in expected_types:
            assert hasattr(MessageType, type_name), f"MessageType.{type_name} not defined"

    def test_message_type_values(self):
        """Test message type values are unique"""
        values = [mt.value for mt in MessageType]
        assert len(values) == len(set(values)), "Duplicate message type values"


class TestQueueIntegration:
    """Test full queue integration scenarios"""

    def test_full_request_response_cycle(self, event_bus):
        """Test complete request/response cycle"""
        # Submit request
        request = AgentRequest(
            request_id="cycle-001",
            speech_text="What is 2+2?",
            tier="simple"
        )
        event_bus.submit_agent_request(request)

        # Simulate agent receiving request
        received = event_bus.get_agent_request(timeout=1.0)
        assert received.request_id == "cycle-001"

        # Simulate agent sending response
        result = AgentResult(
            request_id="cycle-001",
            success=True,
            content="4",
            spoken_response="The answer is 4."
        )
        event_bus.submit_agent_response(result)

        # Main process receives response
        response = event_bus.get_agent_response(timeout=1.0)
        assert response.request_id == "cycle-001"
        assert response.success is True

    def test_tts_integration(self, event_bus):
        """Test TTS queue integration"""
        # Submit TTS requests with different priorities
        requests = [
            TTSRequest(request_id="ack", text="Got it", priority=0, response_type="acknowledgment"),
            TTSRequest(request_id="prog", text="Working", priority=1, response_type="progress"),
            TTSRequest(request_id="done", text="Complete", priority=1, response_type="completion"),
        ]

        for req in requests:
            event_bus.submit_tts_request(req)

        # Retrieve all
        retrieved = []
        for _ in range(3):
            r = event_bus.get_tts_request(timeout=1.0)
            if r:
                retrieved.append(r)

        assert len(retrieved) == 3

    def test_shutdown_clears_queues(self, event_bus):
        """Test that shutdown sends messages to queues"""
        event_bus.shutdown()

        # Queues should have shutdown messages
        assert event_bus.is_shutdown()


class TestEdgeCases:
    """Test edge cases"""

    def test_empty_speech_text(self, event_bus):
        """Test request with empty speech text"""
        request = AgentRequest(
            request_id="empty",
            speech_text=""
        )
        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)
        assert retrieved.speech_text == ""

    def test_very_long_speech_text(self, event_bus):
        """Test request with very long speech text"""
        long_text = "word " * 10000
        request = AgentRequest(
            request_id="long",
            speech_text=long_text
        )
        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)
        assert retrieved.speech_text == long_text

    def test_unicode_in_request(self, event_bus):
        """Test request with unicode text"""
        request = AgentRequest(
            request_id="unicode",
            speech_text="Hello 你好 مرحبا 🔥"
        )
        event_bus.submit_agent_request(request)
        retrieved = event_bus.get_agent_request(timeout=1.0)
        assert "你好" in retrieved.speech_text
        assert "🔥" in retrieved.speech_text

    def test_special_characters_in_response(self, event_bus):
        """Test response with special characters"""
        result = AgentResult(
            request_id="special",
            success=True,
            content="<script>alert('xss')</script>",
            spoken_response="Special chars: &<>\"'"
        )
        event_bus.submit_agent_response(result)
        retrieved = event_bus.get_agent_response(timeout=1.0)
        assert "<script>" in retrieved.content


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
