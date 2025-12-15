def merge_dicts(d1: dict, d2: dict) -> dict:
    """
    Merge two dictionaries into a new dictionary. If a key exists in both input dictionaries,
    the function attempts to add their values using the + operator. Inputs are not modified.

    Args:
        d1 (dict): First dictionary.
        d2 (dict): Second dictionary.

    Returns:
        dict: A new dictionary with merged keys and summed values for overlapping keys.

    Raises:
        TypeError: If either argument is not a dict or if values for the same key cannot be added.

    Example:
        merge_dicts({'a': 1, 'b': 2}, {'b': 3, 'c': 4}) -> {'a': 1, 'b': 5, 'c': 4}
    """
    if not isinstance(d1, dict):
        raise TypeError(f"d1 must be a dict, got {type(d1).__name__}")
    if not isinstance(d2, dict):
        raise TypeError(f"d2 must be a dict, got {type(d2).__name__}")

    result = d1.copy()
    for key, value in d2.items():
        if key in result:
            try:
                result[key] = result[key] + value
            except Exception as e:
                raise TypeError(f"Cannot add values for key {key!r}: {e}") from e
        else:
            result[key] = value
    return result
