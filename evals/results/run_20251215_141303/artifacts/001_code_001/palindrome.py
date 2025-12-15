def is_palindrome(s):
    """Return True if string s is a palindrome, ignoring spaces and case."""
    if s is None:
        return False
    normalized = ''.join(ch.lower() for ch in s if not ch.isspace())
    return normalized == normalized[::-1]
