class Stack:
    """Simple LIFO stack implementation."""

    def __init__(self):
        self._items = []

    def push(self, item):
        """Add item to the top of the stack."""
        self._items.append(item)

    def pop(self):
        """Remove and return the top item. Raise IndexError if the stack is empty."""
        if self.is_empty():
            raise IndexError("pop from empty stack")
        return self._items.pop()

    def peek(self):
        """Return the top item without removing it. Raise IndexError if the stack is empty."""
        if self.is_empty():
            raise IndexError("peek from empty stack")
        return self._items[-1]

    def is_empty(self):
        """Return True if the stack is empty."""
        return len(self._items) == 0

    def __repr__(self):
        return f"Stack({self._items!r})"
