def reverse_words(s):
    """Return a new string with the order of words in s reversed.

    Words are sequences separated by any whitespace. Leading/trailing and multiple
    spaces are collapsed into single spaces in the output.
    """
    if not isinstance(s, str):
        raise TypeError('Input must be a string')
    words = s.split()
    return ' '.join(reversed(words))


if __name__ == '__main__':
    # simple demonstration
    print(reverse_words('Hello World Python'))
