def is_palindrome(s):
    """Return True if string s is a palindrome ignoring spaces and case.

    Examples:
        is_palindrome("A man a plan a canal Panama") -> True
    """
    if not isinstance(s, str):
        raise TypeError("Input must be a string")
    # Remove spaces and normalize to lowercase
    cleaned = ''.join(ch.lower() for ch in s if ch != ' ')
    # Check if cleaned string equals its reverse
    return cleaned == cleaned[::-1]


if __name__ == "__main__":
    # Simple tests
    tests = [
        ("A man a plan a canal Panama", True),
        ("Racecar", True),
        ("Hello", False),
        ("", True),
        (" ", True)
    ]
    for inp, expected in tests:
        result = is_palindrome(inp)
        print(repr(inp), "->", result, "(expected:", expected, ")")
