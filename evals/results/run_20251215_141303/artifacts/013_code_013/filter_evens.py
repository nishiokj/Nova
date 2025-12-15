def filter_evens(numbers):
    """Return a new list containing only even numbers from the input list.

    Example:
        filter_evens([1, 2, 3, 4, 5, 6]) -> [2, 4, 6]
    """
    return [n for n in numbers if n % 2 == 0]
