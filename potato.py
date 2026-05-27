"""A small module defining a Potato class."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Potato:
    """Represents a potato.

    Attributes:
        variety: The potato variety, such as "Russet" or "Yukon Gold".
        weight_grams: The potato's weight in grams.
        is_cooked: Whether the potato has been cooked.
    """

    variety: str = "Russet"
    weight_grams: float = 150.0
    is_cooked: bool = False

    def __post_init__(self) -> None:
        """Validate potato attributes after initialization."""
        if not self.variety:
            raise ValueError("variety must be a non-empty string")
        if self.weight_grams <= 0:
            raise ValueError("weight_grams must be greater than 0")

    def cook(self) -> None:
        """Mark the potato as cooked."""
        self.is_cooked = True

    def peel(self) -> str:
        """Return a message indicating the potato has been peeled."""
        return f"Peeled the {self.variety} potato."

    def describe(self) -> str:
        """Return a human-readable description of the potato."""
        state = "cooked" if self.is_cooked else "raw"
        return f"A {state} {self.variety} potato weighing {self.weight_grams:g}g."
