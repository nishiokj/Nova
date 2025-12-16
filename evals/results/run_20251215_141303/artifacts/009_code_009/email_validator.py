import re


def validate_email(email):
    """Return True if email matches username@domain.extension

    - Username: letters, digits, underscores
    - Domain: letters, digits, hyphens
    - Extension: 2-4 letters
    """
    pattern = r'^[A-Za-z0-9_]+@[A-Za-z0-9-]+\.[A-Za-z]{2,4}$'
    return re.fullmatch(pattern, email) is not None
