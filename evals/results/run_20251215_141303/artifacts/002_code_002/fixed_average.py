def calculate_average(numbers):
    """Return the average of numbers. For an empty list, return 0."""
    if not numbers:
        return 0
    total = 0
    for num in numbers:
        total += num
    return total / len(numbers)
