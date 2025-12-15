def remove_duplicates(lst):
    """Return a new list with duplicates removed while preserving order.

    Example:
        remove_duplicates([1, 2, 2, 3, 1, 4]) -> [1, 2, 3, 4]
    """
    seen = set()
    result = []
    for item in lst:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


if __name__ == "__main__":
    # simple demonstration
    example = [1, 2, 2, 3, 1, 4]
    print("Input:", example)
    print("Output:", remove_duplicates(example))
